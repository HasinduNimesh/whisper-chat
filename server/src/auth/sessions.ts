/**
 * Session tokens + cookie plumbing. The raw token lives only in the
 * HttpOnly cookie; the database sees its SHA-256. Expiry slides on every
 * authenticated request (30-day window).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { COOKIE_SECURE } from '../config.js';
import { readCookie } from '../http/helpers.js';
import { createSession, deleteSession, getSessionUser, type SessionUser } from '../db/index.js';

export const SESSION_COOKIE = 'whisper_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieAttributes(maxAgeSeconds: number): string {
  return [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    `HttpOnly`,
    `SameSite=Lax`,
    ...(COOKIE_SECURE ? ['Secure'] : []),
  ].join('; ');
}

/** Mint a session for `userId` and set its cookie on the response. */
export async function startSession(
  res: ServerResponse,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await createSession(hashToken(token), userId, new Date(Date.now() + SESSION_TTL_MS), meta);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttributes(SESSION_TTL_MS / 1000)}`);
}

/** Resolve the request's session cookie to a user (sliding expiry). */
export async function sessionFromRequest(req: IncomingMessage): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 256) return null;
  return getSessionUser(hashToken(token), new Date(Date.now() + SESSION_TTL_MS));
}

/** Destroy the request's session (if any) and expire the cookie. */
export async function endSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token && token.length <= 256) await deleteSession(hashToken(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(0)}`);
}
