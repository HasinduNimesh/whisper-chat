/**
 * Request guards for the cookie-authenticated /api surface (dashboard).
 *
 * CSRF strategy (documented in SECURITY.md): state-changing requests must
 * (1) carry `X-Requested-With: fetch` — a non-simple header that forces a
 * CORS preflight, which cross-site HTML forms cannot produce, and
 * (2) present no Origin, or an allow-listed / same-host Origin.
 * Combined with SameSite=Lax cookies this closes login CSRF too.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALLOWED_ORIGINS } from '../config.js';
import { sendJson } from './helpers.js';
import { sessionFromRequest } from '../auth/sessions.js';
import type { SessionUser } from '../db/index.js';
import type { OrgRole } from '../db/index.js';

function sameHostOrigin(req: IncomingMessage, origin: string): boolean {
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** CSRF check for state-changing routes. Responds (403) and returns false on failure. */
export function checkCsrf(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers['x-requested-with'] !== 'fetch') {
    sendJson(res, 403, { error: 'Missing X-Requested-With header' });
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    const allowed =
      ALLOWED_ORIGINS.length === 0 // dev mode: no allow-list configured
        ? true
        : ALLOWED_ORIGINS.includes(origin) || sameHostOrigin(req, origin);
    if (!allowed) {
      sendJson(res, 403, { error: 'Origin not allowed' });
      return false;
    }
  }
  return true;
}

/** Resolve the session; responds 401 and returns null when absent/expired. */
export async function requireSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<SessionUser | null> {
  const user = await sessionFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in' });
    return null;
  }
  return user;
}

/** requireSession + role check (403 on mismatch). */
export async function requireRole(
  req: IncomingMessage,
  res: ServerResponse,
  role: OrgRole,
): Promise<SessionUser | null> {
  const user = await requireSession(req, res);
  if (!user) return null;
  if (user.role !== role) {
    sendJson(res, 403, { error: 'Insufficient permissions' });
    return null;
  }
  return user;
}
