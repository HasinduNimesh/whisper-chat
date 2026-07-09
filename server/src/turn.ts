/**
 * TURN credentials via Metered.ca (optional). Delivered only inside join
 * acknowledgements on an authenticated WS session — never a public HTTP
 * route. Unset env => no TURN servers; calls fall back to STUN-only.
 *
 * METERED_API_KEY holds a credential-scoped `apiKey` (create one via
 * Dashboard -> TURN Server -> Add Credential, then "Show API Key" on it).
 * That's distinct from the account's `secretKey` (Dashboard -> Developers) —
 * the secretKey mints new credentials but this simpler flow just reads back
 * the ICE servers array for a credential that already exists.
 */
import type { IceServerLike } from '@private-chat/shared';
import { METERED_API_KEY, METERED_DOMAIN } from './config.js';

const TURN_CACHE_MS = 60 * 60 * 1000; // re-fetch at most once an hour
let turnCache: { servers: IceServerLike[]; expiresAt: number } | null = null;
// Single-flight guard: coalesce concurrent cache-miss callers into one fetch.
let turnFetchInFlight: Promise<IceServerLike[]> | null = null;

export async function fetchTurnCredentials(): Promise<IceServerLike[]> {
  if (!METERED_API_KEY || !METERED_DOMAIN) return [];
  if (turnCache && turnCache.expiresAt > Date.now()) return turnCache.servers;
  if (turnFetchInFlight) return turnFetchInFlight;
  turnFetchInFlight = (async () => {
    try {
      const res = await fetch(
        `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[turn] Metered request failed: ${res.status} ${res.statusText} ${body}`);
        return [];
      }
      const servers = (await res.json()) as IceServerLike[];
      if (!Array.isArray(servers) || servers.length === 0) {
        console.error('[turn] Metered returned no ICE servers', servers);
        return [];
      }
      turnCache = { servers, expiresAt: Date.now() + TURN_CACHE_MS };
      return servers;
    } catch (err) {
      console.error('[turn] fetching Metered credentials threw', err);
      return [];
    } finally {
      turnFetchInFlight = null;
    }
  })();
  return turnFetchInFlight;
}
