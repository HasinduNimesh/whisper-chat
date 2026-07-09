/**
 * Organizations (tenants). Every other org-scoped repo takes an `orgId` as
 * its first parameter and scopes its SQL by `org_id` — that convention is the
 * tenant-isolation seam for the whole data layer.
 */
import { requirePool } from './pool.js';

export type EncryptionMode = 'e2e' | 'managed';

export interface Org {
  id: string;
  name: string;
  slug: string;
  encryptionMode: EncryptionMode;
  createdAt: Date;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  encryption_mode: EncryptionMode;
  created_at: Date;
}

function toOrg(r: OrgRow): Org {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    encryptionMode: r.encryption_mode,
    createdAt: r.created_at,
  };
}

const ORG_COLUMNS = 'id, name, slug, encryption_mode, created_at';

/** Create an org. Returns null when the slug is already taken (no throw — expected race). */
export async function createOrg(input: {
  name: string;
  slug: string;
  encryptionMode: EncryptionMode;
}): Promise<Org | null> {
  const res = await requirePool().query<OrgRow>(
    `INSERT INTO orgs (name, slug, encryption_mode)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING
     RETURNING ${ORG_COLUMNS}`,
    [input.name, input.slug, input.encryptionMode],
  );
  return res.rows[0] ? toOrg(res.rows[0]) : null;
}

export async function getOrgById(orgId: string): Promise<Org | null> {
  const res = await requirePool().query<OrgRow>(
    `SELECT ${ORG_COLUMNS} FROM orgs WHERE id = $1`,
    [orgId],
  );
  return res.rows[0] ? toOrg(res.rows[0]) : null;
}

export async function getOrgBySlug(slug: string): Promise<Org | null> {
  const res = await requirePool().query<OrgRow>(
    `SELECT ${ORG_COLUMNS} FROM orgs WHERE slug = $1`,
    [slug],
  );
  return res.rows[0] ? toOrg(res.rows[0]) : null;
}

export async function updateOrgName(orgId: string, name: string): Promise<void> {
  await requirePool().query('UPDATE orgs SET name = $2 WHERE id = $1', [orgId, name]);
}

/**
 * Switch encryption mode — only while the org has no conversations yet (the
 * mode is snapshotted per conversation; flipping it later would strand
 * history in the other trust model). Enforced in SQL, not JS, so it holds
 * under concurrency. Returns false when blocked.
 */
export async function updateOrgEncryptionMode(
  orgId: string,
  mode: EncryptionMode,
): Promise<boolean> {
  const res = await requirePool().query(
    `UPDATE orgs SET encryption_mode = $2
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM conversations WHERE org_id = $1)`,
    [orgId, mode],
  );
  return (res.rowCount ?? 0) > 0;
}
