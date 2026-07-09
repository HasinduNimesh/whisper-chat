/**
 * Org staff accounts (admins and agents). Emails are globally unique in v1
 * so login doesn't need an org picker. Deleting an account is a soft
 * disable — message attribution must survive staff turnover.
 */
import { requirePool } from './pool.js';

export type OrgRole = 'admin' | 'agent';

export interface OrgUser {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  publicKey: string | null;
  disabledAt: Date | null;
  createdAt: Date;
}

interface OrgUserRow {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  role: OrgRole;
  public_key: string | null;
  disabled_at: Date | null;
  created_at: Date;
}

function toUser(r: OrgUserRow): OrgUser {
  return {
    id: r.id,
    orgId: r.org_id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    publicKey: r.public_key,
    disabledAt: r.disabled_at,
    createdAt: r.created_at,
  };
}

const USER_COLUMNS = 'id, org_id, email, display_name, role, public_key, disabled_at, created_at';

/** Create a staff account. Returns null when the email is already registered. */
export async function createUser(
  orgId: string,
  input: { email: string; passwordHash: string; displayName: string; role: OrgRole },
): Promise<OrgUser | null> {
  const res = await requirePool().query<OrgUserRow>(
    `INSERT INTO org_users (org_id, email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${USER_COLUMNS}`,
    [orgId, input.email, input.passwordHash, input.displayName, input.role],
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

/**
 * Login lookup — the ONLY function that returns the password hash, and it is
 * deliberately not org-scoped (the email itself locates the org).
 */
export async function getUserForLogin(
  email: string,
): Promise<(OrgUser & { passwordHash: string }) | null> {
  const res = await requirePool().query<OrgUserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM org_users WHERE email = $1`,
    [email],
  );
  const row = res.rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

export async function getUserById(orgId: string, userId: string): Promise<OrgUser | null> {
  const res = await requirePool().query<OrgUserRow>(
    `SELECT ${USER_COLUMNS} FROM org_users WHERE org_id = $1 AND id = $2`,
    [orgId, userId],
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

/** All staff of an org (active and disabled — the UI shows the distinction). */
export async function listUsers(orgId: string): Promise<OrgUser[]> {
  const res = await requirePool().query<OrgUserRow>(
    `SELECT ${USER_COLUMNS} FROM org_users WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return res.rows.map(toUser);
}

/** Soft-disable an account. Returns false when the user isn't in this org. */
export async function disableUser(orgId: string, userId: string): Promise<boolean> {
  const res = await requirePool().query(
    `UPDATE org_users SET disabled_at = now()
     WHERE org_id = $1 AND id = $2 AND disabled_at IS NULL`,
    [orgId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Register/rotate an agent's E2E public key (E2E-mode orgs). */
export async function setUserPublicKey(
  orgId: string,
  userId: string,
  publicKey: string,
): Promise<void> {
  await requirePool().query(
    'UPDATE org_users SET public_key = $3 WHERE org_id = $1 AND id = $2',
    [orgId, userId, publicKey],
  );
}
