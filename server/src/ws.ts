/**
 * WebSocket signaling/relay wiring, attachable to any node:http server (the
 * real entrypoint attaches it in index.ts; tests attach it to ephemeral
 * servers). Handles both worlds:
 *  - legacy private rooms: join / leave / relay / signal
 *  - org conversations:    join-conversation / send / relay / join-inbox
 * A socket belongs to at most one of the two.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  RESERVED_ROOM_PREFIX,
  type ClientMessage,
  type ServerMessage,
  type ErrorCode,
  type RoomMember,
} from '@private-chat/shared';
import {
  getRoom,
  joinRoom,
  leaveRoom,
  roomCount,
  toIdentity,
  ROOM_MAX_PEERS,
  type Peer,
} from './rooms.js';
import {
  upsertRoomMember,
  fetchRoomMembers,
  persistMessage,
  fetchHistory,
} from './db/index.js';
import {
  ALLOWED_ORIGINS,
  HEARTBEAT_MS,
  MAX_CONNS_PER_IP,
  MAX_PAYLOAD,
  MAX_ROOMS,
  MSG_BURST,
  MSG_REFILL_PER_SEC,
} from './config.js';
import { isValidPublicKey } from './lib/validate.js';
import { clientIp } from './http/helpers.js';
import { fetchTurnCredentials } from './turn.js';
import {
  handleConversationDisconnect,
  handleConversationRelay,
  handleJoinConversation,
  handleJoinInbox,
  handleSend,
  isConversationClient,
} from './conversationHub.js';

/** Live connection count per client IP, for the per-IP cap. */
const connsPerIp = new Map<string, number>();

interface SocketState {
  ip: string;
  alive: boolean;
  /** Token bucket for inbound-message rate limiting. */
  tokens: number;
  lastRefill: number;
}

const stateOf = new WeakMap<WebSocket, SocketState>();
/** The HTTP upgrade request — carries cookies for conversation/inbox auth. */
const requestOf = new WeakMap<WebSocket, IncomingMessage>();
/** Per-socket state: the legacy-room peer record once joined. */
const peerOf = new WeakMap<WebSocket, Peer>();

/** Consume one rate-limit token; false when the socket is over its budget. */
function allowMessage(socket: WebSocket): boolean {
  const st = stateOf.get(socket);
  if (!st) return false;
  const now = Date.now();
  st.tokens = Math.min(MSG_BURST, st.tokens + ((now - st.lastRefill) / 1000) * MSG_REFILL_PER_SEC);
  st.lastRefill = now;
  if (st.tokens < 1) return false;
  st.tokens -= 1;
  return true;
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function fail(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { type: 'error', code, message });
}

async function handleJoin(
  socket: WebSocket,
  roomId: string,
  publicKey: string,
  displayName: string,
  ephemeral: boolean,
): Promise<void> {
  if (peerOf.has(socket) || isConversationClient(socket)) {
    fail(socket, 'bad-request', 'Already in a room');
    return;
  }
  if (!roomId || typeof roomId !== 'string' || roomId.length > 128) {
    fail(socket, 'invalid-room', 'Invalid room id');
    return;
  }
  // Conversations are addressed by their own message types — the prefix is
  // reserved so a legacy join can never collide with that namespace.
  if (roomId.startsWith(RESERVED_ROOM_PREFIX)) {
    fail(socket, 'invalid-room', 'Reserved room id');
    return;
  }
  if (!isValidPublicKey(publicKey)) {
    fail(socket, 'bad-request', 'Invalid public key');
    return;
  }
  // Cap the number of distinct rooms to bound memory against room-flood DoS.
  if (!getRoom(roomId) && roomCount() >= MAX_ROOMS) {
    fail(socket, 'bad-request', 'Server is at capacity, try again later');
    return;
  }
  const trimmedName = String(displayName ?? '').slice(0, 64) || 'Anonymous';
  const peer: Peer = {
    id: randomUUID(),
    socket,
    publicKey,
    displayName: trimmedName,
    roomId,
  };
  const result = joinRoom(roomId, peer, ephemeral);
  if (!result.ok) {
    fail(socket, 'room-full', `This room is full (max ${ROOM_MAX_PEERS} people)`);
    return;
  }
  peerOf.set(socket, peer);
  // Server-authoritative: fixed by whoever created the room, see rooms.ts.
  const roomIsEphemeral = result.room.ephemeral;

  // Announce the newcomer to everyone else right away; don't make them wait
  // on the TURN fetch / DB round-trips below.
  for (const other of result.room.peers.values()) {
    if (other.id === peer.id) continue;
    send(other.socket, { type: 'peer-joined', peer: toIdentity(peer) });
  }

  // Record this member durably (survives disconnects) so others can still
  // address a message to them while they're offline. Merge the always-
  // available live roster (works even with no DB configured, matching
  // today's behavior exactly) with the durable one (adds previously-seen,
  // currently-offline members — a no-op when persistence isn't set up).
  // Ephemeral rooms skip this entirely: not just message content, but the
  // "who was in this room" metadata too — nothing about the room touches
  // the database, full stop.
  const durableMembers = roomIsEphemeral
    ? []
    : await (async () => {
        await upsertRoomMember(roomId, publicKey, trimmedName).catch((err) =>
          console.error('[db] upsertRoomMember failed', err),
        );
        return fetchRoomMembers(roomId, publicKey).catch((err) => {
          console.error('[db] fetchRoomMembers failed', err);
          return [];
        });
      })();
  const membersByKey = new Map<string, RoomMember>();
  for (const other of result.room.peers.values()) {
    if (other.id === peer.id) continue;
    membersByKey.set(other.publicKey, {
      publicKey: other.publicKey,
      displayName: other.displayName,
      online: true,
      peerId: other.id,
    });
  }
  for (const m of durableMembers) {
    if (!membersByKey.has(m.publicKey)) {
      membersByKey.set(m.publicKey, { ...m, online: false });
    }
  }
  const members = [...membersByKey.values()];

  const iceServers = await fetchTurnCredentials();
  const history = roomIsEphemeral
    ? []
    : await fetchHistory(roomId, publicKey).catch((err) => {
        console.error('[db] fetchHistory failed', err);
        return [];
      });
  send(socket, {
    type: 'joined',
    selfId: peer.id,
    roomId,
    members,
    iceServers,
    history,
    ephemeral: roomIsEphemeral,
  });
}

function handleLeave(socket: WebSocket): void {
  const peer = peerOf.get(socket);
  if (!peer) return;
  peerOf.delete(socket);
  const room = leaveRoom(peer);
  if (!room) return;
  for (const other of room.peers.values()) {
    send(other.socket, { type: 'peer-left', peerId: peer.id });
  }
}

/**
 * Relay a chat message, addressed by the recipient's permanent public key
 * (not a PeerId, which only exists while they're connected). If they're
 * currently online, deliver live; independently and unconditionally (not
 * gated on live delivery succeeding), persist a durable copy when the
 * client asked us to — that's what makes offline delivery and cross-device
 * history possible. Sending to yourself is just one more target here, same
 * as any other recipient — except we never live-deliver it back (the
 * sender already has their own optimistic local echo; this copy exists
 * purely to be persisted for later/other-device retrieval).
 */
async function handleRelay(socket: WebSocket, msg: Extract<ClientMessage, { type: 'relay' }>): Promise<void> {
  // Sealed relays inside E2E conversations share the frame type but route
  // through the conversation hub (mode enforcement lives there).
  if (isConversationClient(socket)) return handleConversationRelay(socket, msg);

  const peer = peerOf.get(socket);
  if (!peer) return fail(socket, 'not-in-room', 'Join a room first');
  if (!isValidPublicKey(msg.to)) return fail(socket, 'bad-request', 'Invalid recipient');
  const room = getRoom(peer.roomId);
  if (!room) return;

  const target = [...room.peers.values()].find((p) => p.publicKey === msg.to);
  if (target && target.id !== peer.id) {
    send(target.socket, { type: 'deliver', from: peer.publicKey, ciphertext: msg.ciphertext, nonce: msg.nonce });
  }
  // room.ephemeral overrides msg.persist unconditionally — the guarantee
  // must hold even against a stale/buggy/malicious client that still sends
  // persist:true, since the room's mode was fixed at creation, not per message.
  if (msg.persist && !room.ephemeral) {
    await persistMessage({
      roomId: peer.roomId,
      recipientPublicKey: msg.to,
      senderPublicKey: peer.publicKey,
      senderDisplayName: peer.displayName,
      ciphertext: msg.ciphertext,
      nonce: msg.nonce,
      sentAt: Date.now(),
    }).catch((err) => console.error('[db] persistMessage failed', err));
  }
}

function handleSignal(socket: WebSocket, msg: Extract<ClientMessage, { type: 'signal' }>): void {
  const peer = peerOf.get(socket);
  if (!peer) return fail(socket, 'not-in-room', 'Join a room first');
  const room = getRoom(peer.roomId);
  if (!room) return;
  const target = room.peers.get(msg.to);
  if (!target) return;
  send(target.socket, { type: 'signal', from: peer.id, signal: msg.signal });
}

/** Attach the WS server to an HTTP server. Returns the WebSocketServer. */
export function attachSignaling(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ origin }, done) => {
      // No Origin header => non-browser client (curl, native); allow it.
      // Browser clients send Origin; enforce the allow-list when configured.
      if (ALLOWED_ORIGINS.length === 0 || !origin || ALLOWED_ORIGINS.includes(origin)) {
        done(true);
        return;
      }
      done(false, 403, 'Forbidden origin');
    },
  });

  wss.on('connection', (socket, req: IncomingMessage) => {
    const ip = clientIp(req);
    const open = connsPerIp.get(ip) ?? 0;
    if (open >= MAX_CONNS_PER_IP) {
      // Refuse before allocating any room/peer state.
      fail(socket, 'bad-request', 'Too many connections');
      socket.close(1008, 'Too many connections');
      return;
    }
    connsPerIp.set(ip, open + 1);
    stateOf.set(socket, { ip, alive: true, tokens: MSG_BURST, lastRefill: Date.now() });
    requestOf.set(socket, req);

    const cleanup = (): void => {
      handleLeave(socket);
      handleConversationDisconnect(socket);
      const n = (connsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) connsPerIp.delete(ip);
      else connsPerIp.set(ip, n);
    };

    socket.on('pong', () => {
      const st = stateOf.get(socket);
      if (st) st.alive = true;
    });

    socket.on('message', (data) => {
      if (!allowMessage(socket)) {
        // Over the rate budget — drop the frame and disconnect a flooding client.
        socket.close(1008, 'Rate limit exceeded');
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return fail(socket, 'bad-request', 'Malformed JSON');
      }
      switch (msg?.type) {
        case 'join':
          return handleJoin(socket, msg.roomId, msg.publicKey, msg.displayName, Boolean(msg.ephemeral));
        case 'leave':
          return handleLeave(socket);
        case 'relay':
          return handleRelay(socket, msg);
        case 'signal':
          return handleSignal(socket, msg);
        // Conversation handlers may hit the DB; contain every failure to
        // this socket (incl. OrgFeaturesUnavailableError on DB-less runs).
        case 'join-conversation':
          return void handleJoinConversation(socket, requestOf.get(socket) ?? req, msg, peerOf.has(socket)).catch(
            (err) => {
              console.error('[ws] join-conversation failed', err);
              fail(socket, 'unauthorized', 'Not authorized for this conversation');
            },
          );
        case 'send':
          return void handleSend(socket, msg).catch((err) => {
            console.error('[ws] send failed', err);
            fail(socket, 'bad-request', 'Message could not be delivered');
          });
        case 'join-inbox':
          return void handleJoinInbox(socket, requestOf.get(socket) ?? req).catch((err) => {
            console.error('[ws] join-inbox failed', err);
            fail(socket, 'unauthorized', 'Inbox subscription failed');
          });
        default:
          return fail(socket, 'bad-request', 'Unknown message type');
      }
    });

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Heartbeat: ping every socket; terminate any that missed the previous round.
  // Reaps half-open TCP connections that never send a clean close.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const st = stateOf.get(socket);
      if (st && !st.alive) {
        socket.terminate();
        continue;
      }
      if (st) st.alive = false;
      try {
        socket.ping();
      } catch {
        /* socket already gone */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
