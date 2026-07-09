/**
 * Persistence layer entry point. Everything is gated on DATABASE_URL — see
 * pool.ts. Legacy private-chat persistence and the org/tenant repos live in
 * their own modules; import from this index.
 */
export {
  getPool,
  closePool,
  normalizeSslMode,
  DatabaseRequiredError,
  HandlesUnavailableError,
  OrgFeaturesUnavailableError,
} from './pool.js';
export { initDb } from './migrate.js';
export * from './legacy.js';
export * from './orgs.js';
export * from './users.js';
export * from './sessions.js';
export * from './invites.js';
export * from './apiKeys.js';
export * from './visitors.js';
export * from './conversations.js';
export * from './convMessages.js';
