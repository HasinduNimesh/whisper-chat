/**
 * Staff auth + org administration REST routes (cookie-authenticated
 * dashboard surface). Mounted on the shared Router by http/app.ts.
 *
 * Security posture:
 * - uniform "Invalid credentials" on login (no account enumeration), with a
 *   dummy argon2 verify when the email is unknown (no timing oracle)
 * - per-IP and per-email fixed-window rate limits on credential endpoints
 * - CSRF: X-Requested-With + Origin checks on every mutation (guards.ts)
 * - invite/session tokens live only in URLs/cookies; the DB sees hashes
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALLOW_ORG_SIGNUP, AUTH_RATE_LIMIT } from '../config.js';
import type { Router } from '../http/router.js';
import { clientIp, readJsonBody, sendJson } from '../http/helpers.js';
import { checkCsrf, requireRole, requireSession } from '../http/guards.js';
import { makeFixedWindowLimiter } from '../http/rateLimit.js';
import { dummyHash, hashPassword, verifyPassword } from './passwords.js';
import { endSession, hashToken, startSession } from './sessions.js';
import {
  attributeInvite,
  consumeInvite,
  createInvite,
  createOrg,
  createUser,
  deleteOrg,
  deleteSessionsForUser,
  disableUser,
  getOrgById,
  getUsableInvite,
  getUserForLogin,
  listUsers,
  releaseInvite,
  setUserPublicKey,
  updateOrgEncryptionMode,
  updateOrgName,
  type Org,
  type OrgUser,
  type SessionUser,
} from '../db/index.js';
import {
  isValidEmail,
  isValidPassword,
  isValidPublicKey,
  isValidSlug,
  normalizeDisplayName,
} from '../lib/validate.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Credential endpoints get strict fixed windows; ordinary authenticated
// reads/writes are already bounded by session checks + connection limits.
const ipLimiter = makeFixedWindowLimiter({ limit: AUTH_RATE_LIMIT, windowMs: 60_000 });
const emailLimiter = makeFixedWindowLimiter({ limit: AUTH_RATE_LIMIT, windowMs: 60_000 });

function limited(req: IncomingMessage, res: ServerResponse, extraKey?: string): boolean {
  if (!ipLimiter.allow(`ip:${clientIp(req)}`)) {
    sendJson(res, 429, { error: 'Too many requests, try again shortly' });
    return true;
  }
  if (extraKey && !emailLimiter.allow(extraKey)) {
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

function publicUser(u: OrgUser | SessionUser): Record<string, unknown> {
  if ('userId' in u) {
    return {
      id: u.userId,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      publicKey: u.publicKey,
    };
  }
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    publicKey: u.publicKey,
    disabled: u.disabledAt !== null,
    createdAt: u.createdAt,
  };
}

function publicOrg(org: Org): Record<string, unknown> {
  return { id: org.id, name: org.name, slug: org.slug, encryptionMode: org.encryptionMode };
}

export function registerAuthRoutes(router: Router): void {
  // ── Org registration ───────────────────────────────────────────────────
  router.post('/api/orgs', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    if (!ALLOW_ORG_SIGNUP) return sendJson(res, 403, { error: 'Org signup is disabled on this server' });
    if (limited(req, res)) return;
    const b = await body(req, res);
    if (!b) return;

    const { orgName, slug, encryptionMode, email, password, displayName } = b;
    if (!isValidSlug(slug)) return sendJson(res, 400, { error: 'Invalid slug (3-40 chars, a-z 0-9 -)' });
    if (encryptionMode !== 'e2e' && encryptionMode !== 'managed') {
      return sendJson(res, 400, { error: 'encryptionMode must be "e2e" or "managed"' });
    }
    if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Invalid email' });
    if (!isValidPassword(password)) {
      return sendJson(res, 400, { error: 'Password must be 8-512 characters' });
    }
    const name = normalizeDisplayName(orgName, '');
    if (!name) return sendJson(res, 400, { error: 'Organization name is required' });

    const org = await createOrg({ name, slug, encryptionMode });
    if (!org) return sendJson(res, 409, { error: 'That slug is already taken' });

    const admin = await createUser(org.id, {
      email: String(email).toLowerCase(),
      passwordHash: await hashPassword(String(password)),
      displayName: normalizeDisplayName(displayName),
      role: 'admin',
    });
    if (!admin) {
      await deleteOrg(org.id); // compensate: don't strand an adminless org
      return sendJson(res, 409, { error: 'That email is already registered' });
    }

    await startSession(res, admin.id, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    return sendJson(res, 201, { org: publicOrg(org), user: publicUser(admin) });
  });

  // ── Login / logout / me ────────────────────────────────────────────────
  router.post('/api/auth/login', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    const b = await body(req, res);
    if (!b) return;
    const email = typeof b.email === 'string' ? b.email.toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (limited(req, res, `login:${email}`)) return;

    const invalid = (): void => sendJson(res, 401, { error: 'Invalid credentials' });
    if (!isValidEmail(email) || !isValidPassword(password)) return invalid();

    const user = await getUserForLogin(email);
    if (!user || user.disabledAt) {
      await verifyPassword(await dummyHash(), password); // equalize timing
      return invalid();
    }
    if (!(await verifyPassword(user.passwordHash, password))) return invalid();

    const org = await getOrgById(user.orgId);
    if (!org) return invalid();
    await startSession(res, user.id, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    return sendJson(res, 200, { org: publicOrg(org), user: publicUser(user) });
  });

  router.post('/api/auth/logout', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    await endSession(req, res);
    return sendJson(res, 200, { ok: true });
  });

  // Kill every session of this account (stolen-cookie response, shared
  // machines). Requires a live session — which is also the one that dies.
  router.post('/api/auth/logout-all', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    const user = await requireSession(req, res);
    if (!user) return;
    await deleteSessionsForUser(user.userId);
    await endSession(req, res); // idempotent; expires the cookie
    return sendJson(res, 200, { ok: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    const user = await requireSession(req, res);
    if (!user) return;
    const org = await getOrgById(user.orgId);
    if (!org) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { org: publicOrg(org), user: publicUser(user) });
  });

  // E2E-mode agents publish their identity key so peers can seal to them.
  router.patch('/api/auth/me/public-key', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    const user = await requireSession(req, res);
    if (!user) return;
    const b = await body(req, res);
    if (!b) return;
    if (typeof b.publicKey !== 'string' || !isValidPublicKey(b.publicKey)) {
      return sendJson(res, 400, { error: 'Invalid public key' });
    }
    await setUserPublicKey(user.orgId, user.userId, b.publicKey);
    return sendJson(res, 200, { ok: true });
  });

  // ── Invites ────────────────────────────────────────────────────────────
  router.post('/api/invites', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    const admin = await requireRole(req, res, 'admin');
    if (!admin) return;
    const b = await body(req, res);
    if (!b) return;
    const role = b.role === 'admin' ? 'admin' : 'agent';

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await createInvite(admin.orgId, {
      tokenHash: hashToken(token),
      role,
      createdBy: admin.userId,
      expiresAt,
    });
    // The raw token is returned exactly once; only its hash is stored.
    return sendJson(res, 201, { token, role, expiresAt: expiresAt.toISOString() });
  });

  // Public peek so the accept page can show org/role before asking for details.
  router.get('/api/invites/:token', async (req, res, params) => {
    if (limited(req, res)) return;
    const invite = await getUsableInvite(hashToken(params.token));
    if (!invite) return sendJson(res, 404, { error: 'Invite not found or expired' });
    return sendJson(res, 200, { orgName: invite.orgName, role: invite.role });
  });

  router.post('/api/invites/accept', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    if (limited(req, res)) return;
    const b = await body(req, res);
    if (!b) return;
    const { token, email, password, displayName } = b;
    if (typeof token !== 'string' || token.length > 256) {
      return sendJson(res, 400, { error: 'Invalid invite token' });
    }
    if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Invalid email' });
    if (!isValidPassword(password)) {
      return sendJson(res, 400, { error: 'Password must be 8-512 characters' });
    }

    const tokenHash = hashToken(token);
    const invite = await getUsableInvite(tokenHash);
    if (!invite) return sendJson(res, 404, { error: 'Invite not found or expired' });

    // Win the invite first (single-use is enforced atomically), then create
    // the account; release the invite if account creation loses on email.
    if (!(await consumeInvite(tokenHash, null))) {
      return sendJson(res, 409, { error: 'Invite already used' });
    }
    const user = await createUser(invite.orgId, {
      email: String(email).toLowerCase(),
      passwordHash: await hashPassword(String(password)),
      displayName: normalizeDisplayName(displayName),
      role: invite.role,
    });
    if (!user) {
      await releaseInvite(tokenHash);
      return sendJson(res, 409, { error: 'That email is already registered' });
    }
    await attributeInvite(tokenHash, user.id);

    const org = await getOrgById(invite.orgId);
    await startSession(res, user.id, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    return sendJson(res, 201, { org: org ? publicOrg(org) : null, user: publicUser(user) });
  });

  // ── Org settings & staff management ────────────────────────────────────
  router.patch('/api/org/settings', async (req, res) => {
    if (!checkCsrf(req, res)) return;
    const admin = await requireRole(req, res, 'admin');
    if (!admin) return;
    const b = await body(req, res);
    if (!b) return;

    if (b.name !== undefined) {
      const name = normalizeDisplayName(b.name, '');
      if (!name) return sendJson(res, 400, { error: 'Invalid organization name' });
      await updateOrgName(admin.orgId, name);
    }
    if (b.encryptionMode !== undefined) {
      if (b.encryptionMode !== 'e2e' && b.encryptionMode !== 'managed') {
        return sendJson(res, 400, { error: 'encryptionMode must be "e2e" or "managed"' });
      }
      const changed = await updateOrgEncryptionMode(admin.orgId, b.encryptionMode);
      if (!changed) {
        return sendJson(res, 409, {
          error: 'Encryption mode is locked once the organization has conversations',
        });
      }
    }
    const org = await getOrgById(admin.orgId);
    return sendJson(res, 200, { org: org ? publicOrg(org) : null });
  });

  // Any staff member can list colleagues (needed for assignment UIs);
  // mutating staff is admin-only.
  router.get('/api/org/agents', async (req, res) => {
    const user = await requireSession(req, res);
    if (!user) return;
    const users = await listUsers(user.orgId);
    return sendJson(res, 200, { agents: users.map(publicUser) });
  });

  router.delete('/api/org/agents/:id', async (req, res, params) => {
    if (!checkCsrf(req, res)) return;
    const admin = await requireRole(req, res, 'admin');
    if (!admin) return;
    if (params.id === admin.userId) {
      return sendJson(res, 400, { error: 'You cannot disable your own account' });
    }
    const ok = await disableUser(admin.orgId, params.id);
    if (!ok) return sendJson(res, 404, { error: 'No such active account in your organization' });
    await deleteSessionsForUser(params.id);
    return sendJson(res, 200, { ok: true });
  });
}
