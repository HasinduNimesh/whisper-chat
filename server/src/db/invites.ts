/**
 * One-time staff invite links. Like sessions, only the SHA-256 of the invite
 * token is stored; the raw token lives solely in the URL the admin copies.
 */
import { requirePool } from './pool.js';
import type { OrgRole } from './users.js';

export interface Invite {
  orgId: string;
  role: OrgRole;
  createdBy: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export async function createInvite(
  orgId: string,
  input: { tokenHash: string; role: OrgRole; createdBy: string; expiresAt: Date },
): Promise<void> {
  await requirePool().query(
    `INSERT INTO org_invites (token_hash, org_id, role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.tokenHash, orgId, input.role, input.createdBy, input.expiresAt],
  );
}

/** Look up a *usable* invite (exists, unexpired, unused) with its org name. */
export async function getUsableInvite(
  tokenHash: string,
): Promise<(Invite & { orgName: string }) | null> {
  const res = await requirePool().query<{
    org_id: string;
    role: OrgRole;
    created_by: string;
    expires_at: Date;
    used_at: Date | null;
    org_name: string;
  }>(
    `SELECT i.org_id, i.role, i.created_by, i.expires_at, i.used_at, o.name AS org_name
     FROM org_invites i JOIN orgs o ON o.id = i.org_id
     WHERE i.token_hash = $1 AND i.expires_at > now() AND i.used_at IS NULL`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    orgId: row.org_id,
    role: row.role,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    orgName: row.org_name,
  };
}

/**
 * Atomically consume an invite. Returns false if it was already used or has
 * expired — first accepter wins on the race. `usedBy` may be null when the
 * account doesn't exist yet (the accept flow consumes first, then creates
 * the user and back-fills attribution with `attributeInvite`).
 */
export async function consumeInvite(tokenHash: string, usedBy: string | null): Promise<boolean> {
  const res = await requirePool().query(
    `UPDATE org_invites SET used_by = $2, used_at = now()
     WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL`,
    [tokenHash, usedBy],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Compensating action: un-consume an invite when account creation failed
 * after the invite was already won (e.g. email conflict) so the link isn't
 * burned by a failed attempt.
 */
export async function releaseInvite(tokenHash: string): Promise<void> {
  await requirePool().query(
    'UPDATE org_invites SET used_by = NULL, used_at = NULL WHERE token_hash = $1',
    [tokenHash],
  );
}

/** Back-fill who used an invite once their account row exists. */
export async function attributeInvite(tokenHash: string, usedBy: string): Promise<void> {
  await requirePool().query('UPDATE org_invites SET used_by = $2 WHERE token_hash = $1', [
    tokenHash,
    usedBy,
  ]);
}
