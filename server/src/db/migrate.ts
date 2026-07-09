/**
 * Tiny numbered-migration runner. Takes a Postgres advisory lock so multiple
 * server instances booting against the same database can't race, records
 * applied migrations in `schema_migrations`, and applies each pending
 * migration in its own transaction.
 */
import { getPool } from './pool.js';
import { MIGRATIONS } from './migrations.js';

/** Arbitrary but stable app-wide advisory lock key for migrations. */
const MIGRATION_LOCK_KEY = 0x77_68_73_70; // "whsp"

let initPromise: Promise<void> | null = null;

/** Apply pending migrations. No-op without DATABASE_URL. Memoized per boot. */
export function initDb(): Promise<void> {
  const p = getPool();
  if (!p) return Promise.resolve();
  if (!initPromise) {
    initPromise = runMigrations().catch((err) => {
      initPromise = null; // allow a retry on next call rather than caching failure
      console.error('[db] schema migration failed', err);
      throw err;
    });
  }
  return initPromise;
}

async function runMigrations(): Promise<void> {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INT PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const res = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(res.rows.map((r) => Number(r.id)));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
          migration.id,
          migration.name,
        ]);
        await client.query('COMMIT');
        console.log(`[db] applied migration ${migration.id} (${migration.name})`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
