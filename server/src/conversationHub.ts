/**
 * Live WebSocket state for organization conversations — the parallel of
 * rooms.ts for the customer-chat world, plus org-wide inbox subscriptions
 * for dashboard staff.
 *
 * Security model:
 * - Authentication/authorization happen in handleJoinConversation BEFORE any
 *   state is allocated for the socket.
 * - The conversation's encryption mode is enforced per frame: plaintext
 *   'send' only in managed conversations, sealed 'relay' only in E2E ones.
 * - Every DB access goes through the org-scoped repos (tenant isolation).
 */
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type {
  ClientMessage,
  ConversationMessageEvent,
  ConversationPeer,
  ErrorCode,
  ServerMessage,
} from '@private-chat/shared';
import {
  addParticipant,
  getConversation,
  getOrgBySlug,
  insertE2eMessage,
  insertManagedMessage,
  listE2eMessages,
  listManagedMessages,
  listParticipants,
  touchConversation,
  type Conversation,
  type Participant,
} from './db/index.js';
import { sessionFromRequest } from './auth/sessions.js';
import { verifyOrgToken } from './auth/orgTokens.js';
import { resolveVisitor } from './auth/visitors.js';
import { isValidPublicKey } from './lib/validate.js';
import { fetchTurnCredentials } from './turn.js';

const MAX_TEXT_LENGTH = 8192; // managed-mode message cap (8 KiB of UTF-16 units)

interface ConvClient {
  orgId: string;
  conversationId: string;
  participantId: string;
  kind: ConversationPeer['kind'];
  displayName: string;
  publicKey: string | null;
  encryption: 'e2e' | 'managed';
}

const clientOf = new WeakMap<WebSocket, ConvClient>();
const socketsByConversation = new Map<string, Set<WebSocket>>();
const inboxSocketsByOrg = new Map<string, Set<WebSocket>>();
const inboxOrgOf = new WeakMap<WebSocket, string>();

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function fail(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { type: 'error', code, message });
}

export function isConversationClient(socket: WebSocket): boolean {
  return clientOf.has(socket);
}

function toPeer(p: Participant, online: boolean): ConversationPeer {
  return {
    participantId: p.id,
    kind: p.kind,
    displayName: p.displayName,
    publicKey: p.publicKey,
    online,
  };
}

function onlineParticipantIds(conversationId: string): Set<string> {
  const ids = new Set<string>();
  for (const socket of socketsByConversation.get(conversationId) ?? []) {
    const c = clientOf.get(socket);
    if (c) ids.add(c.participantId);
  }
  return ids;
}

function broadcast(conversationId: string, msg: ServerMessage, except?: WebSocket): void {
  for (const socket of socketsByConversation.get(conversationId) ?? []) {
    if (socket !== except) send(socket, msg);
  }
}

/** Notify an org's dashboard inbox sockets (new conversation / new message). */
export function notifyInbox(
  orgId: string,
  event: 'new-conversation' | 'message',
  conversationId: string,
): void {
  for (const socket of inboxSocketsByOrg.get(orgId) ?? []) {
    send(socket, { type: 'inbox-event', event, conversationId });
  }
}

/**
 * Resolve join-conversation auth to (conversation, participant). All
 * failures collapse to null — the caller answers a uniform 'unauthorized'
 * so probing can't distinguish "wrong secret" from "no such conversation".
 */
async function authorize(
  req: IncomingMessage,
  msg: Extract<ClientMessage, { type: 'join-conversation' }>,
  publicKey: string | undefined,
): Promise<{ conversation: Conversation; participant: Participant } | null> {
  const { auth, conversationId } = msg;
  if (!auth || typeof auth !== 'object') return null;

  if (auth.kind === 'session') {
    const user = await sessionFromRequest(req);
    if (!user) return null;
    const conversation = await getConversation(user.orgId, conversationId);
    if (!conversation) return null;
    // Any staff member of the org may work any of its conversations.
    const participant = await addParticipant(user.orgId, conversation.id, {
      kind: 'agent',
      agentId: user.userId,
      displayName: user.displayName,
      publicKey,
    });
    return { conversation, participant };
  }

  if (auth.kind === 'visitor') {
    if (typeof auth.orgSlug !== 'string' || typeof auth.secret !== 'string') return null;
    const org = await getOrgBySlug(auth.orgSlug.slice(0, 64));
    if (!org) return null;
    const visitor = await resolveVisitor(org.id, auth.secret);
    if (!visitor) return null;
    const conversation = await getConversation(org.id, conversationId);
    if (!conversation) return null;
    // Visitors must already be participants (added by the REST create flow);
    // a visitor secret is NOT a license to wander into other conversations.
    const existing = (await listParticipants(org.id, conversation.id)).find(
      (p) => p.kind === 'visitor' && p.visitorId === visitor.id,
    );
    if (!existing) return null;
    const participant = publicKey
      ? await addParticipant(org.id, conversation.id, {
          kind: 'visitor',
          visitorId: visitor.id,
          displayName: existing.displayName,
          publicKey,
        })
      : existing;
    return { conversation, participant };
  }

  if (auth.kind === 'org-token') {
    if (typeof auth.token !== 'string') return null;
    let verified;
    try {
      verified = await verifyOrgToken(auth.token);
    } catch {
      return null;
    }
    const conversation = await getConversation(verified.orgId, conversationId);
    if (!conversation) return null;
    // The token authorizes ONE conversation: its conv key. Without this
    // check, any valid token would open every conversation in the org.
    if (conversation.externalKey === null || conversation.externalKey !== verified.convKey) {
      return null;
    }
    const participant = await addParticipant(verified.orgId, conversation.id, {
      kind: 'external',
      externalId: verified.externalId,
      displayName: verified.displayName,
      publicKey,
    });
    return { conversation, participant };
  }

  return null;
}

export async function handleJoinConversation(
  socket: WebSocket,
  req: IncomingMessage,
  msg: Extract<ClientMessage, { type: 'join-conversation' }>,
  alreadyInRoom: boolean,
): Promise<void> {
  if (clientOf.has(socket) || alreadyInRoom) {
    return fail(socket, 'bad-request', 'Already joined');
  }
  if (typeof msg.conversationId !== 'string' || msg.conversationId.length > 64) {
    return fail(socket, 'bad-request', 'Invalid conversation id');
  }
  let publicKey: string | undefined;
  if (msg.publicKey !== undefined) {
    if (typeof msg.publicKey !== 'string' || !isValidPublicKey(msg.publicKey)) {
      return fail(socket, 'bad-request', 'Invalid public key');
    }
    publicKey = msg.publicKey;
  }

  const authorized = await authorize(req, msg, publicKey);
  if (!authorized) {
    return fail(socket, 'unauthorized', 'Not authorized for this conversation');
  }
  const { conversation, participant } = authorized;

  // Register live state only after authorization succeeded.
  const client: ConvClient = {
    orgId: conversation.orgId,
    conversationId: conversation.id,
    participantId: participant.id,
    kind: participant.kind,
    displayName: participant.displayName,
    publicKey: participant.publicKey,
    encryption: conversation.encryption,
  };
  const wasOnline = onlineParticipantIds(conversation.id).has(participant.id);
  clientOf.set(socket, client);
  let sockets = socketsByConversation.get(conversation.id);
  if (!sockets) {
    sockets = new Set();
    socketsByConversation.set(conversation.id, sockets);
  }
  sockets.add(socket);

  // Announce presence (first socket of this participant only).
  if (!wasOnline) {
    broadcast(conversation.id, {
      type: 'conversation-peer',
      conversationId: conversation.id,
      peer: toPeer(participant, true),
    }, socket);
  }

  const participants = await listParticipants(conversation.orgId, conversation.id);
  const online = onlineParticipantIds(conversation.id);

  const base = {
    type: 'conversation-joined' as const,
    conversationId: conversation.id,
    selfParticipantId: participant.id,
    conversation: {
      kind: conversation.kind,
      encryption: conversation.encryption,
      status: conversation.status,
      context: conversation.context,
    },
    participants: participants.map((p) => toPeer(p, online.has(p.id))),
    iceServers: await fetchTurnCredentials(),
  };

  if (conversation.encryption === 'managed') {
    const names = new Map(participants.map((p) => [p.id, p] as const));
    const history = (await listManagedMessages(conversation.orgId, conversation.id)).map(
      (m): ConversationMessageEvent => ({
        type: 'message',
        conversationId: conversation.id,
        id: m.id,
        from: {
          participantId: m.senderParticipantId,
          kind: names.get(m.senderParticipantId)?.kind ?? 'external',
          displayName: names.get(m.senderParticipantId)?.displayName ?? 'Unknown',
        },
        text: m.body,
        sentAt: m.sentAt,
      }),
    );
    send(socket, { ...base, history });
  } else {
    const e2eHistory = participant.publicKey
      ? await listE2eMessages(conversation.orgId, conversation.id, participant.publicKey)
      : [];
    send(socket, { ...base, e2eHistory });
  }
}

export async function handleSend(
  socket: WebSocket,
  msg: Extract<ClientMessage, { type: 'send' }>,
): Promise<void> {
  const client = clientOf.get(socket);
  if (!client) return fail(socket, 'not-in-room', 'Join a conversation first');
  if (client.encryption !== 'managed') {
    return fail(socket, 'wrong-mode', 'This conversation is end-to-end encrypted; plaintext frames are not accepted');
  }
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return fail(socket, 'bad-request', `Message must be 1-${MAX_TEXT_LENGTH} characters`);
  }
  // Re-read status per send: an agent may close the conversation mid-flight.
  const conversation = await getConversation(client.orgId, client.conversationId);
  if (!conversation) return fail(socket, 'not-in-room', 'Conversation no longer exists');
  if (conversation.status === 'closed') {
    return fail(socket, 'conversation-closed', 'This conversation is closed');
  }

  const sentAt = Date.now();
  const stored = await insertManagedMessage(client.orgId, {
    conversationId: client.conversationId,
    senderParticipantId: client.participantId,
    body: text,
    sentAt,
  });
  await touchConversation(client.orgId, client.conversationId);

  const event: ConversationMessageEvent = {
    type: 'message',
    conversationId: client.conversationId,
    id: stored.id,
    from: {
      participantId: client.participantId,
      kind: client.kind,
      displayName: client.displayName,
    },
    text,
    sentAt,
  };
  // Echo to everyone including the sender — the echo is the delivery ack.
  broadcast(client.conversationId, event);
  notifyInbox(client.orgId, 'message', client.conversationId);
}

/**
 * Sealed relay inside an E2E conversation (same wire format as legacy
 * rooms, addressed by recipient public key). Returns without sending
 * anything when the recipient is offline and persist wasn't requested.
 */
export async function handleConversationRelay(
  socket: WebSocket,
  msg: Extract<ClientMessage, { type: 'relay' }>,
): Promise<void> {
  const client = clientOf.get(socket);
  if (!client) return fail(socket, 'not-in-room', 'Join a conversation first');
  if (client.encryption !== 'e2e') {
    return fail(socket, 'wrong-mode', 'This conversation is managed; use plaintext send frames');
  }
  if (!client.publicKey) {
    return fail(socket, 'bad-request', 'Join with a public key before relaying');
  }
  if (!isValidPublicKey(msg.to)) return fail(socket, 'bad-request', 'Invalid recipient');

  for (const other of socketsByConversation.get(client.conversationId) ?? []) {
    if (other === socket) continue;
    const c = clientOf.get(other);
    if (c && c.publicKey === msg.to) {
      send(other, { type: 'deliver', from: client.publicKey, ciphertext: msg.ciphertext, nonce: msg.nonce });
    }
  }
  if (msg.persist) {
    await insertE2eMessage(client.orgId, {
      conversationId: client.conversationId,
      recipientPublicKey: msg.to,
      senderPublicKey: client.publicKey,
      senderDisplayName: client.displayName,
      ciphertext: msg.ciphertext,
      nonce: msg.nonce,
      sentAt: Date.now(),
    }).catch((err) => console.error('[db] insertE2eMessage failed', err));
  }
}

export async function handleJoinInbox(socket: WebSocket, req: IncomingMessage): Promise<void> {
  const user = await sessionFromRequest(req);
  if (!user) return fail(socket, 'unauthorized', 'Sign in to subscribe to the inbox');
  let sockets = inboxSocketsByOrg.get(user.orgId);
  if (!sockets) {
    sockets = new Set();
    inboxSocketsByOrg.set(user.orgId, sockets);
  }
  sockets.add(socket);
  inboxOrgOf.set(socket, user.orgId);
  send(socket, { type: 'inbox-joined' });
}

/** Tear down any conversation/inbox state this socket held. */
export function handleConversationDisconnect(socket: WebSocket): void {
  const client = clientOf.get(socket);
  if (client) {
    clientOf.delete(socket);
    const sockets = socketsByConversation.get(client.conversationId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) socketsByConversation.delete(client.conversationId);
    }
    // Presence: offline only when the participant's last socket is gone.
    if (!onlineParticipantIds(client.conversationId).has(client.participantId)) {
      broadcast(client.conversationId, {
        type: 'conversation-peer',
        conversationId: client.conversationId,
        peer: {
          participantId: client.participantId,
          kind: client.kind,
          displayName: client.displayName,
          publicKey: client.publicKey,
          online: false,
        },
      });
    }
  }

  const inboxOrg = inboxOrgOf.get(socket);
  if (inboxOrg) {
    inboxOrgOf.delete(socket);
    const sockets = inboxSocketsByOrg.get(inboxOrg);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) inboxSocketsByOrg.delete(inboxOrg);
    }
  }
}
