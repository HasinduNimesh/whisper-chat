/**
 * Per-org HMAC signing keys for store/marketplace-issued identity tokens.
 * The secret is stored as-is by necessity — HMAC verification needs the raw
 * key. Mitigations: DB access control, `kid`-based rotation, revocation, and
 * the secret is returned to the admin exactly once (at creation).
 */
import { requirePool } from './pool.js';

export interface ApiKey {
  id: string;
  orgId: string;
  kid: string;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
}

interface ApiKeyRow {
  id: string;
  org_id: string;
  kid: string;
  label: string;
  created_at: Date;
  revoked_at: Date | null;
}

function toApiKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    orgId: r.org_id,
    kid: r.kid,
    label: r.label,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

export async function createApiKey(
  orgId: string,
  input: { kid: string; secret: string; label: string },
): Promise<ApiKey> {
  const res = await requirePool().query<ApiKeyRow>(
    `INSERT INTO org_api_keys (org_id, kid, secret, label)
     VALUES ($1, $2, $3, $4)
     RETURNING id, org_id, kid, label, created_at, revoked_at`,
    [orgId, input.kid, input.secret, input.label],
  );
  return toApiKey(res.rows[0]);
}

/** List an org's keys — never includes the secret. */
export async function listApiKeys(orgId: string): Promise<ApiKey[]> {
  const res = await requirePool().query<ApiKeyRow>(
    `SELECT id, org_id, kid, label, created_at, revoked_at
     FROM org_api_keys WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return res.rows.map(toApiKey);
}

/**
 * Token-verification lookup by `kid`. Deliberately NOT org-scoped — the kid
 * is what identifies the org. Returns the secret plus the owning org; the
 * verifier must treat `revokedAt` as a hard reject.
 */
export async function getApiKeyForVerify(
  kid: string,
): Promise<{ orgId: string; secret: string; revokedAt: Date | null } | null> {
  const res = await requirePool().query<{
    org_id: string;
    secret: string;
    revoked_at: Date | null;
  }>('SELECT org_id, secret, revoked_at FROM org_api_keys WHERE kid = $1', [kid]);
  const row = res.rows[0];
  return row ? { orgId: row.org_id, secret: row.secret, revokedAt: row.revoked_at } : null;
}

/** Revoke a key. Returns false when the key doesn't belong to this org. */
export async function revokeApiKey(orgId: string, id: string): Promise<boolean> {
  const res = await requirePool().query(
    `UPDATE org_api_keys SET revoked_at = now()
     WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [orgId, id],
  );
  return (res.rowCount ?? 0) > 0;
}
