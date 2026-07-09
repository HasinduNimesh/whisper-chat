/**
 * Server configuration — every env var in one place. See .env.example for
 * the annotated operator-facing reference.
 */

export const PORT = Number(process.env.PORT ?? 8787);
// Bind address. Default (unset) listens on all interfaces — good for LAN/dev.
// Behind a reverse proxy (nginx), set HOST=127.0.0.1 to keep it private.
export const HOST = process.env.HOST;
export const MAX_PAYLOAD = 256 * 1024; // 256 KiB cap per frame

// Comma-separated allow-list of browser Origins permitted to connect (WS +
// credentialed HTTP). Unset = allow any origin (fine for LAN/dev; set this in
// production).
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP ?? 30);
export const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 10_000);
// Token-bucket message rate limit per socket: burst capacity + refill/sec.
export const MSG_BURST = Number(process.env.MSG_BURST ?? 180);
export const MSG_REFILL_PER_SEC = Number(process.env.MSG_REFILL_PER_SEC ?? 60);
export const HEARTBEAT_MS = 30_000;

// @handle directory HTTP rate limit (requests/min/IP).
export const HANDLE_RATE_LIMIT = Number(process.env.HANDLE_RATE_LIMIT ?? 20);

// Auth endpoint rate limits (requests/min). Applied per-IP and, for login,
// also per-email — both windows must have room.
export const AUTH_RATE_LIMIT = Number(process.env.AUTH_RATE_LIMIT ?? 10);

// TURN via Metered.ca (optional).
export const METERED_API_KEY = process.env.METERED_API_KEY;
export const METERED_DOMAIN = process.env.METERED_DOMAIN;

// Session cookies require HTTPS unless explicitly disabled for local HTTP dev.
export const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';

// Whether anyone may register a new organization on this server. Self-hosters
// running a closed instance set ALLOW_ORG_SIGNUP=false after creating theirs.
export const ALLOW_ORG_SIGNUP = process.env.ALLOW_ORG_SIGNUP !== 'false';
