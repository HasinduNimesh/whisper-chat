/**
 * Conversation REST surface, two trust domains:
 *
 * WIDGET routes (/api/widget/*) — called from arbitrary store websites.
 *   CORS is open (no credentials); authentication is a signed org token
 *   (C2C / identified B2C) or a visitor secret (anonymous B2C). Cookies are
 *   NEVER read here, so these routes need no CSRF protection.
 *
 * AGENT routes (/api/conversations*, /api/org/api-keys*) — dashboard staff,
 *   cookie session + org scoping + CSRF guards, like auth/routes.ts.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTH_RATE_LIMIT } from '../config.js';
import type { Router } from '../http/router.js';
import { clientIp, readJsonBody, sendJson } from './helpers.js';
import { checkCsrf, requireRole, requireSession } from './guards.js';
import { makeFixedWindowLimiter } from './rateLimit.js';
import { OrgTokenError, verifyOrgToken } from '../auth/orgTokens.js';
import { notifyInbox } from '../conversationHub.js';
import { mintVisitor, resolveVisitor } from '../auth/visitors.js';
import {
  addParticipant,
  assignConversation,
  createApiKey,
  createConversation,
  getConversation,
  getConversationByExternalKey,
  getOpenConversationForVisitor,
  getOrgById,
  getOrgBySlug,
  getUserById,
  listApiKeys,
  listConversations,
  listManagedMessages,
  listParticipants,
  listParticipantsForConversations,
  revokeApiKey,
  setConversationStatus,
  type Conversation,
  type ConversationStatus,
  type Participant,
} from '../db/index.js';
import { isValidPublicKey, normalizeDisplayName } from '../lib/validate.js';

// Widget endpoints face the open internet without sessions — keep a hard
// per-IP lid on them (shared window with the credential endpoints' size).
const widgetLimiter = makeFixedWindowLimiter({ limit: AUTH_RATE_LIMIT * 3, windowMs: 60_000 });

function widgetLimited(req: IncomingMessage, res: ServerResponse): boolean {
  if (!widgetLimiter.allow(clientIp(req))) {
    sendJson(res, 429, { error: 'Too many requests, try again shortly' });
    return true;
  }
  return false;
}

async function body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await readJsonBody(req, 16 * 1024);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  sendJson(res, 400, { error: 'Malformed request' });
  return null;
}

function publicConversation(c: Conversation, participants?: Participant[]) {
  return {
    id: c.id,
    kind: c.kind,
    encryption: c.encryption,
    status: c.status,
    context: c.context,
    assignedAgentId: c.assignedAgentId,
    createdAt: c.createdAt,
    lastMessageAt: c.lastMessageAt,
    ...(participants
      ? {
          participants: participants.map((p) => ({
            id: p.id,
            kind: p.kind,
            displayName: p.displayName,
            publicKey: p.publicKey,
            agentId: p.agentId,
          })),
        }
      : {}),
  };
}

/**
 * Resolve the caller of a widget conversation route to a participant of that
 * conversation, via org token (Authorization: Bearer) or visitor secret
 * (X-Visitor-Secret). Responds 401/404 and returns null on failure.
 */
async function widgetCallerParticipant(
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
): Promise<{ conversation: Conversation; participant: Participant } | null> {
  const auth = req.headers.authorization;
  const visitorSecret = req.headers['x-visitor-secret'];

  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    let verified;
    try {
      verified = await verifyOrgToken(auth.slice('Bearer '.length));
    } catch (err) {
      sendJson(res, 401, { error: err instanceof OrgTokenError ? err.message : 'Invalid token' });
      return null;
    }
    const conversation = await getConversation(verified.orgId, conversationId);
    if (!conversation) {
      sendJson(res, 404, { error: 'Conversation not found' });
      return null;
    }
    const participant = (await listParticipants(verified.orgId, conversationId)).find(
      (p) => p.kind === 'external' && p.externalId === verified.externalId,
    );
    if (!participant) {
      sendJson(res, 403, { error: 'Not a participant of this conversation' });
      return null;
    }
    return { conversation, participant };
  }

  if (typeof visitorSecret === 'string') {
    // The visitor's org comes from the conversation's own org via the slug
    // the widget already knows — but the secret alone must never let a
    // visitor probe other orgs' conversations. Resolve org from the
    // conversation only AFTER the visitor authenticates against it.
    const orgSlug = req.headers['x-org'];
    const org = typeof orgSlug === 'string' ? await getOrgBySlug(orgSlug.slice(0, 64)) : null;
    if (!org) {
      sendJson(res, 401, { error: 'Unknown organization' });
      return null;
    }
    const visitor = await resolveVisitor(org.id, visitorSecret);
    if (!visitor) {
      sendJson(res, 401, { error: 'Unknown visitor' });
      return null;
    }
    const conversation = await getConversation(org.id, conversationId);
    if (!conversation) {
      sendJson(res, 404, { error: 'Conversation not found' });
      return null;
    }
    const participant = (await listParticipants(org.id, conversationId)).find(
      (p) => p.kind === 'visitor' && p.visitorId === visitor.id,
    );
    if (!participant) {
      sendJson(res, 403, { error: 'Not a participant of this conversation' });
      return null;
    }
    return { conversation, participant };
  }

  sendJson(res, 401, { error: 'Missing credentials' });
  return null;
}

export function registerConversationRoutes(router: Router): void {
  // ── Widget: anonymous visitor bootstrap ────────────────────────────────
  router.post('/api/widget/session', async (req, res) => {
    if (widgetLimited(req, res)) return;
    const b = await body(req, res);
    if (!b) return;
    const org = typeof b.orgSlug === 'string' ? await getOrgBySlug(b.orgSlug.slice(0, 64)) : null;
    if (!org) return sendJson(res, 404, { error: 'Unknown organization' });

    // Re-presenting an existing secret revalidates it (widget reload).
    if (typeof b.visitorSecret === 'string') {
      const existing = await resolveVisitor(org.id, b.visitorSecret);
      if (existing) {
        return sendJson(res, 200, {
          visitorId: existing.id,
          orgName: org.name,
          encryptionMode: org.encryptionMode,
        });
      }
      // Fall through: stale/foreign secret → mint a fresh identity.
    }
    const { visitor, secret } = await mintVisitor(org.id, normalizeDisplayName(b.displayName, 'Visitor'));
    return sendJson(res, 201, {
      visitorId: visitor.id,
      visitorSecret: secret,
      orgName: org.name,
      encryptionMode: org.encryptionMode,
    });
  });

  // ── Widget: create/find a conversation ─────────────────────────────────
  router.post('/api/widget/conversations', async (req, res) => {
    if (widgetLimited(req, res)) return;
    const b = await body(req, res);
    if (!b) return;

    // Path A: signed org token (C2C or identified B2C).
    if (typeof b.token === 'string') {
      let verified;
      try {
        verified = await verifyOrgToken(b.token);
      } catch (err) {
        return sendJson(res, 401, {
          error: err instanceof OrgTokenError ? err.message : 'Invalid token',
        });
      }
      const org = (await getOrgBySlug(String(b.orgSlug ?? ''))) ?? null;
      if (org && org.id !== verified.orgId) {
        // Token was signed for a different org than the widget claims.
        return sendJson(res, 401, { error: 'Token does not match this organization' });
      }

      let conversation = await getConversationByExternalKey(verified.orgId, verified.convKey);
      if (!conversation) {
        const tokenOrg = await getOrgById(verified.orgId);
        if (!tokenOrg) return sendJson(res, 401, { error: 'Unknown organization' });
        conversation = await createConversation(verified.orgId, {
          kind: verified.kind,
          encryption: tokenOrg.encryptionMode,
          externalKey: verified.convKey,
          context: verified.context ?? undefined,
        });
        notifyInbox(verified.orgId, 'new-conversation', conversation.id);
      }
      if (conversation.status === 'closed') {
        await setConversationStatus(verified.orgId, conversation.id, 'open');
      }
      if (b.publicKey !== undefined && !(typeof b.publicKey === 'string' && isValidPublicKey(b.publicKey))) {
        return sendJson(res, 400, { error: 'Invalid public key' });
      }
      const participant = await addParticipant(verified.orgId, conversation.id, {
        kind: 'external',
        externalId: verified.externalId,
        displayName: verified.displayName,
        publicKey: typeof b.publicKey === 'string' ? b.publicKey : undefined,
      });
      const participants = await listParticipants(verified.orgId, conversation.id);
      return sendJson(res, 200, {
        conversation: publicConversation(conversation, participants),
        selfParticipantId: participant.id,
      });
    }

    // Path B: anonymous visitor (B2C).
    const org = typeof b.orgSlug === 'string' ? await getOrgBySlug(b.orgSlug.slice(0, 64)) : null;
    if (!org) return sendJson(res, 404, { error: 'Unknown organization' });
    const visitor = await resolveVisitor(org.id, b.visitorSecret);
    if (!visitor) return sendJson(res, 401, { error: 'Unknown visitor — create a session first' });

    let conversation = await getOpenConversationForVisitor(org.id, visitor.id);
    if (!conversation) {
      conversation = await createConversation(org.id, {
        kind: 'b2c',
        encryption: org.encryptionMode,
      });
      notifyInbox(org.id, 'new-conversation', conversation.id);
    }
    if (b.publicKey !== undefined && !(typeof b.publicKey === 'string' && isValidPublicKey(b.publicKey))) {
      return sendJson(res, 400, { error: 'Invalid public key' });
    }
    const participant = await addParticipant(org.id, conversation.id, {
      kind: 'visitor',
      visitorId: visitor.id,
      displayName: visitor.displayName,
      publicKey: typeof b.publicKey === 'string' ? b.publicKey : undefined,
    });
    const participants = await listParticipants(org.id, conversation.id);
    return sendJson(res, 200, {
      conversation: publicConversation(conversation, participants),
      selfParticipantId: participant.id,
    });
  });

  // ── Widget: managed-mode history ────────────────────────────────────────
  router.get('/api/widget/conversations/:id/messages', async (req, res, params) => {
    if (widgetLimited(req, res)) return;
    const caller = await widgetCallerParticipant(req, res, params.id);
    if (!caller) return;
    if (caller.conversation.encryption !== 'managed') {
      return sendJson(res, 409, {
        error: 'E2E conversations deliver history over the encrypted channel',
      });
    }
    const messages = await listManagedMessages(caller.conversation.orgId, caller.conversation.id);
    return sendJson(res, 200, { messages });
  });

  // ── Agent: inbox ────────────────────────────────────────────────────────
  router.get('/api/conversations', async (req, res) => {
    const user = await requireSession(req, res);
    if (!user) return;
    const url = new URL(req.url ?? '/', 'http://local');
    const status = url.searchParams.get('status');
    const assigned = url.searchParams.get('assigned');

    const conversations = await listConversations(user.orgId, {
      status: status === 'open' || status === 'closed' ? (status as ConversationStatus) : undefined,
      unassigned: assigned === 'unassigned',
      assignedAgentId: assigned === 'me' ? user.userId : undefined,
    });
    const participantsByConv = await listParticipantsForConversations(
      user.orgId,
      conversations.map((c) => c.id),
    );
    return sendJson(res, 200, {
      conversations: conversations.map((c) => publicConversation(c, participantsByConv.get(c.id) ?? [])),
    });
  });

  router.get('/api/conversations/:id', async (req, res, params) => {
    const user = await requireSession(req, res);
    if (!user) return;
    const conversation = await getConversation(user.orgId, params.id);
    if (!conversation) return sendJson(res, 404, { error: 'Conversation not found' });
    const participants = await listParticipants(user.orgId, conversation.id);
    return sendJson(res, 200, { conversation: publicConversation(conversation, participants) });
  });

  router.get('/api/conversations/:id/messages', async (req, res, params) => {
    const user = await requireSession(req, res);
    if (!user) return;
    const conversation = await getConversation(user.orgId, params.id);
    if (!conversation) return sendJson(res, 404, { error: 'Conversation not found' });
    if (conversation.encryption !== 'managed') {
      return sendJson(res, 409, {
        error: 'E2E conversations deliver history over the encrypted channel',
      });
    }
    const messages = await listManagedMessages(user.orgId, conversation.id);
    return sendJson(res, 200, { messages });
  });

  router.post('/api/conversations/:id/assign', async (req, res, params) => {
    if (!checkCsrf(req, res)) return;
    const user = await requireSession(req, res);
    if (!user) return;
    const b = await body(req, res);
    if (!b) return;

    let agentId: string | null;
    if (b.self === true) {
      agentId = user.userId;
    } else if (b.agentId === null) {
      agentId = null; // unassign
    } else if (typeof b.agentId === 'string') {
      const target = await getUserById(user.orgId, b.agentId);
      if (!target || target.disabledAt) {
        return sendJson(res, 404, { error: 'No such active agent in your organization' });
      }
      agentId = target.id;
    } else {
      return sendJson(res, 400, { error: 'Pass self:true, agentId, or agentId:null' });
    }

    const ok = await assignConversation(user.orgId, params.id, agentId);
    if (!ok) return sendJson(res, 404, { error: 'Conversation not found' });
    return sendJson(res, 200, { ok: true, assignedAgentId: agentId });
  });

  router.post('/api/conversations/:id/close', async (req, res, params) => {
    if (!checkCsrf(req, res)) return;
    const user = await requireSession(req, res);
    if (!user) return;
    const ok = await setConversationStatus(user.orgId, params.id, 'closed');
    if (!ok) return sendJson(res, 404, { error: 'Conversation not found' });
    return sendJson(res, 200, { ok: true });
  });

  router.post('/api/conversations/:id/reopen', async (req, res, params) => {
    if (!checkCsrf(req, res)) return;
    const user = await requireSession(req, res);
    if (!user) return;
    const ok = await setConversationStatus(user.orgId, params.id, 'open');
    if (!ok) return sendJson(res, 404, { error: 'Conversation not found' });
    return sendJson(res, 200, { ok: true });
  });

  // ── Admin: API key management ───────────────────────────────────────────
  router.get('/api/org/api-keys', async (req, res) => {
    const admin = await requireRole(req, res, 'admin');
    if (!admin) return;
    return sendJson(res, 200, { keys: await listApiKeys(admin.orgId) });
  });

  router.post('/api/org/api-keys', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    const admin = await requireRole(req, res, 'admin');
    if (!admin) return;
    const b = await body(req, res);
    if (!b) return;

    const kid = `whk_${randomBytes(6).toString('base64url')}`;
    const secret = randomBytes(32).toString('base64url');
    const key = await createApiKey(admin.orgId, {
      kid,
      secret,
      label: normalizeDisplayName(b.label, '').slice(0, 64),
    });
    // The secret is shown exactly once — store it in your backend's config.
    return sendJson(res, 201, { key: { ...key, secret } });
  });

  router.delete('/api/org/api-keys/:id', async (req, res, params) => {
    if (!checkCsrf(req, res)) return;
    const admin = await requireRole(req, res, 'admin');
    if (!admin) return;
    const ok = await revokeApiKey(admin.orgId, params.id);
    if (!ok) return sendJson(res, 404, { error: 'No such active key' });
    return sendJson(res, 200, { ok: true });
  });
}
