/**
 * The server's whole HTTP surface, as one request listener:
 *  - GET / and /healthz     — platform health checks + client keepalive
 *  - /handles/*             — @handle directory (legacy private-chat app)
 *  - /api/*                 — org/staff auth + administration (cookie auth)
 * WebSocket upgrades never reach this listener (ws intercepts them).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HANDLE_RATE_LIMIT } from '../config.js';
import { Router } from './router.js';
import { clientIp, originAllowed, sendJson, setCors, setCredentialedCors, readJsonBody } from './helpers.js';
import { makeFixedWindowLimiter } from './rateLimit.js';
import { registerAuthRoutes } from '../auth/routes.js';
import { registerConversationRoutes } from './conversationRoutes.js';
import { claimHandle, HandlesUnavailableError, lookupHandle } from '../db/index.js';
import { isValidHandle, isValidPublicKey, normalizeDisplayName } from '../lib/validate.js';

// Stateless HTTP requests have no socket to hang the WS token bucket off of;
// a simple fixed-window per-IP counter is enough to stop scripted handle
// squatting/enumeration without new infrastructure.
const handleLimiter = makeFixedWindowLimiter({ limit: HANDLE_RATE_LIMIT, windowMs: 60_000 });

function health(req: IncomingMessage, res: ServerResponse): void {
  // CORS: the deployed client (a different origin) pings this to keep a
  // free-tier host from spinning down. Same allow-list as the WS origin
  // check — harmless either way since this route reveals nothing but "ok".
  const origin = req.headers.origin;
  if (typeof origin === 'string' && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}

async function handleClaimHandle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(req, res, 'POST, OPTIONS');
  if (!handleLimiter.allow(clientIp(req))) {
    return sendJson(res, 429, { error: 'Too many requests, try again shortly' });
  }
  let body: unknown;
  try {
    body = await readJsonBody(req, 4096);
  } catch {
    return sendJson(res, 400, { error: 'Malformed request' });
  }
  const { handle, publicKey, displayName } = (body ?? {}) as Record<string, unknown>;
  if (!isValidHandle(handle)) return sendJson(res, 400, { error: 'Invalid handle' });
  if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
    return sendJson(res, 400, { error: 'Invalid public key' });
  }
  const name = normalizeDisplayName(displayName);
  try {
    const won = await claimHandle(handle, publicKey, name);
    if (!won) return sendJson(res, 409, { error: 'Handle already taken' });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof HandlesUnavailableError) return sendJson(res, 503, { error: err.message });
    console.error('[handles] claim failed', err);
    return sendJson(res, 500, { error: 'Internal error' });
  }
}

async function handleLookupHandle(
  req: IncomingMessage,
  res: ServerResponse,
  handle: string,
): Promise<void> {
  setCors(req, res, 'GET, OPTIONS');
  if (!handleLimiter.allow(clientIp(req))) {
    return sendJson(res, 429, { error: 'Too many requests, try again shortly' });
  }
  if (!isValidHandle(handle)) return sendJson(res, 400, { error: 'Invalid handle' });
  try {
    const result = await lookupHandle(handle);
    if (!result) return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof HandlesUnavailableError) return sendJson(res, 503, { error: err.message });
    console.error('[handles] lookup failed', err);
    return sendJson(res, 500, { error: 'Internal error' });
  }
}

export function createRequestListener(): (req: IncomingMessage, res: ServerResponse) => void {
  const router = new Router();

  router.get('/', (req, res) => health(req, res));
  router.get('/healthz', (req, res) => health(req, res));
  router.post('/handles/claim', handleClaimHandle);
  router.get('/handles/:handle', (req, res, params) => handleLookupHandle(req, res, params.handle));

  registerAuthRoutes(router);
  registerConversationRoutes(router);

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0];

    // Widget routes are embedded on arbitrary store websites: open CORS,
    // deliberately WITHOUT credentials — auth is org tokens / visitor
    // secrets in headers, never cookies.
    const isWidget = path.startsWith('/api/widget/');
    if (isWidget) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Visitor-Secret, X-Org');
    }

    if (req.method === 'OPTIONS') {
      if (isWidget || path.startsWith('/api/')) {
        if (!isWidget) setCredentialedCors(req, res);
        res.writeHead(204).end();
        return;
      }
      if (path.startsWith('/handles/')) {
        setCors(req, res, path === '/handles/claim' ? 'POST, OPTIONS' : 'GET, OPTIONS');
        res.writeHead(204).end();
        return;
      }
    }

    // Dashboard may be served from a different (allow-listed) origin.
    if (!isWidget && path.startsWith('/api/')) setCredentialedCors(req, res);

    if (!router.dispatch(req, res)) {
      res.writeHead(404).end();
    }
  };
}
