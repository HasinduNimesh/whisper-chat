/**
 * Staff sessions. Only SHA-256 hashes of session tokens are stored — a DB
 * leak can't be replayed as live cookies. Expiry is sliding: reads that find
 * a session within its refresh window push `expires_at` forward.
 */
import { requirePool } from './pool.js';
import type { OrgRole } from './users.js';

export interface SessionUser {
  userId: string;
  orgId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  publicKey: string | null;
}

export async function createSession(
  tokenHash: string,
  userId: string,
  expiresAt: Date,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<void> {
  await requirePool().query(
    `INSERT INTO org_sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [tokenHash, userId, expiresAt, meta.ip ?? null, meta.userAgent ?? null],
  );
}

/**
 * Resolve a session token hash to its (active, non-disabled) user, sliding
 * the expiry forward to `newExpiresAt` in the same round trip. Returns null
 * for unknown, expired, or disabled-user sessions.
 */
export async function getSessionUser(
  tokenHash: string,
  newExpiresAt: Date,
): Promise<SessionUser | null> {
  const res = await requirePool().query<{
    user_id: string;
    org_id: string;
    email: string;
    display_name: string;
    role: OrgRole;
    public_key: string | null;
  }>(
    `UPDATE org_sessions s
     SET expires_at = $2
     FROM org_users u
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND u.id = s.user_id
       AND u.disabled_at IS NULL
     RETURNING u.id AS user_id, u.org_id, u.email, u.display_name, u.role, u.public_key`,
    [tokenHash, newExpiresAt],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    orgId: row.org_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    publicKey: row.public_key,
  };
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await requirePool().query('DELETE FROM org_sessions WHERE token_hash = $1', [tokenHash]);
}

/** Kill every session of a user (account disabled, password reset, logout-all). */
export async function deleteSessionsForUser(userId: string): Promise<void> {
  await requirePool().query('DELETE FROM org_sessions WHERE user_id = $1', [userId]);
}

/** Purge expired sessions and invites (periodic janitor). */
export async function deleteExpired(): Promise<void> {
  const p = requirePool();
  await p.query('DELETE FROM org_sessions WHERE expires_at <= now()');
  await p.query('DELETE FROM org_invites WHERE expires_at <= now() AND used_at IS NULL');
}
