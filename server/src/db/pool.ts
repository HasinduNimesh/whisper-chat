/**
 * Postgres pool + availability gating. Entirely gated on DATABASE_URL — if
 * it's unset, `getPool()` returns null and every persistence-backed feature
 * degrades to its in-memory / disabled behavior. Features that have no
 * sensible degraded mode throw a `DatabaseRequiredError` subclass instead,
 * which HTTP handlers surface as a clear 503.
 */
import pg from 'pg';

/**
 * pg-connection-string currently treats sslmode=require/prefer/verify-ca as
 * aliases for verify-full, but warns on every connection that a future major
 * version will switch them to weaker, standard-libpq semantics. That warning
 * fires purely off the string (an explicit `ssl` Pool option doesn't
 * suppress it), so normalize to the unambiguous verify-full here — pins us
 * to today's (correct, cert-verifying) behavior regardless of that future
 * change, and stops the noisy per-connection warning in the logs.
 */
export function normalizeSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    if (['require', 'prefer', 'verify-ca'].includes(parsed.searchParams.get('sslmode') ?? '')) {
      parsed.searchParams.set('sslmode', 'verify-full');
    }
    return parsed.toString();
  } catch {
    return url; // malformed URL — let `pg` itself surface the real error
  }
}

let pool: pg.Pool | null = null;
let resolvedUrl: string | null | undefined;

export function getPool(): pg.Pool | null {
  if (resolvedUrl === undefined) {
    // Resolved lazily (not at module load) so tests can inject DATABASE_URL.
    resolvedUrl = process.env.DATABASE_URL ? normalizeSslMode(process.env.DATABASE_URL) : null;
  }
  if (!resolvedUrl) return null;
  if (!pool) pool = new pg.Pool({ connectionString: resolvedUrl });
  return pool;
}

/** Close the pool (graceful shutdown / test teardown). Safe to call twice. */
export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  resolvedUrl = undefined;
  if (p) await p.end();
}

/** Base class: the feature exists only when DATABASE_URL is configured. */
export class DatabaseRequiredError extends Error {}

export class HandlesUnavailableError extends DatabaseRequiredError {
  constructor() {
    super('Handle directory requires DATABASE_URL to be configured');
  }
}

export class OrgFeaturesUnavailableError extends DatabaseRequiredError {
  constructor() {
    super('Organization features require DATABASE_URL to be configured');
  }
}

/** Pool for org features — throws a 503-mappable error when not configured. */
export function requirePool(): pg.Pool {
  const p = getPool();
  if (!p) throw new OrgFeaturesUnavailableError();
  return p;
}
