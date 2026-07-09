/**
 * Anonymous B2C website visitors. A visitor is identified by a random secret
 * the widget holds; only its SHA-256 is stored, scoped per org.
 */
import { requirePool } from './pool.js';

export interface Visitor {
  id: string;
  orgId: string;
  displayName: string;
}

/** Create a visitor (secret already hashed by the caller). */
export async function createVisitor(
  orgId: string,
  secretHash: string,
  displayName: string,
): Promise<Visitor> {
  const res = await requirePool().query<{ id: string; display_name: string }>(
    `INSERT INTO visitors (org_id, secret_hash, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, secret_hash) DO UPDATE SET last_seen_at = now()
     RETURNING id, display_name`,
    [orgId, secretHash, displayName],
  );
  return { id: res.rows[0].id, orgId, displayName: res.rows[0].display_name };
}

/** Resolve a presented visitor secret (hashed) and refresh last_seen_at. */
export async function getVisitorBySecretHash(
  orgId: string,
  secretHash: string,
): Promise<Visitor | null> {
  const res = await requirePool().query<{ id: string; display_name: string }>(
    `UPDATE visitors SET last_seen_at = now()
     WHERE org_id = $1 AND secret_hash = $2
     RETURNING id, display_name`,
    [orgId, secretHash],
  );
  const row = res.rows[0];
  return row ? { id: row.id, orgId, displayName: row.display_name } : null;
}
