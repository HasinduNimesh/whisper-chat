/**
 * Minimal WebSocket signaling + relay server.
 *
 * Responsibilities (ALL it is allowed to do):
 *  - assign peer ids, manage room membership / presence (2-30 cap)
 *  - relay opaque encrypted chat blobs between peers
 *  - relay WebRTC SDP/ICE signaling between peers
 *
 * It deliberately cannot read message content: chat payloads arrive already
 * sealed with XChaCha20-Poly1305 and are forwarded byte-for-byte.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  ClientMessage,
  ServerMessage,
  ErrorCode,
  IceServerLike,
  RoomMember,
} from '@private-chat/shared';
import {
  getRoom,
  joinRoom,
  leaveRoom,
  roomCount,
  toIdentity,
  ROOM_MAX_PEERS,
  type Peer,
} from './rooms.js';
import { initDb, upsertRoomMember, fetchRoomMembers, persistMessage, fetchHistory } from './db.js';

const PORT = Number(process.env.PORT ?? 8787);
// Bind address. Default (unset) listens on all interfaces — good for LAN/dev.
// Behind a reverse proxy (nginx), set HOST=127.0.0.1 to keep it private.
const HOST = process.env.HOST;
const MAX_PAYLOAD = 256 * 1024; // 256 KiB cap per frame

// --- Abuse limits (DoS hardening) ---------------------------------------
// Comma-separated allow-list of browser Origins permitted to open a socket.
// Unset = allow any origin (fine for LAN/dev; set this in production to block
// cross-site WebSocket hijacking from other websites).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP ?? 30);
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 10_000);
// Token-bucket message rate limit per socket: burst capacity + refill/sec.
// Sized for rooms up to ROOM_MAX_PEERS: sendText fans out one relay frame
// per recipient (including a self-addressed copy for history), so one
// logical chat message in a full 30-person room costs ~31 tokens.
const MSG_BURST = Number(process.env.MSG_BURST ?? 180);
const MSG_REFILL_PER_SEC = Number(process.env.MSG_REFILL_PER_SEC ?? 60);
const HEARTBEAT_MS = 30_000;

// --- TURN credentials (Metered.ca) --------------------------------------
// Delivered only inside the 'joined' message on this authenticated WS
// session (never a public HTTP route — join is already gated by the same
// per-IP connection cap and message rate limiter as everything else here).
// Unset => no TURN servers; calls fall back to STUN-only (fine on the same
// network, may fail across strict NATs). Get a free account at metered.ca.
//
// METERED_API_KEY holds a credential-scoped `apiKey` (create one via
// Dashboard -> TURN Server -> Add Credential, then "Show API Key" on it).
// That's distinct from the account's `secretKey` (Dashboard -> Developers) —
// the secretKey mints new credentials but this simpler flow just reads back
// the ICE servers array for a credential that already exists.
const METERED_API_KEY = process.env.METERED_API_KEY;
const METERED_DOMAIN = process.env.METERED_DOMAIN;
const TURN_CACHE_MS = 60 * 60 * 1000; // re-fetch at most once an hour
let turnCache: { servers: IceServerLike[]; expiresAt: number } | null = null;
// Single-flight guard: coalesce concurrent cache-miss callers into one fetch.
let turnFetchInFlight: Promise<IceServerLike[]> | null = null;

async function fetchTurnCredentials(): Promise<IceServerLike[]> {
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

/** Live connection count per client IP, for the per-IP cap. */
const connsPerIp = new Map<string, number>();

/** Resolve the client IP, honoring X-Forwarded-For when behind a proxy. */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

interface SocketState {
  ip: string;
  alive: boolean;
  /** Token bucket for inbound-message rate limiting. */
  tokens: number;
  lastRefill: number;
}

const stateOf = new WeakMap<WebSocket, SocketState>();

/** Consume one rate-limit token; false when the socket is over its budget. */
function allowMessage(socket: WebSocket): boolean {
  const st = stateOf.get(socket);
  if (!st) return false;
  const now = Date.now();
  st.tokens = Math.min(MSG_BURST, st.tokens + ((now - st.lastRefill) / 1000) * MSG_REFILL_PER_SEC);
  st.lastRefill = now;
  if (st.tokens < 1) return false;
  st.tokens -= 1;
  return true;
}

/** Validate that a base64 string decodes to a 32-byte X25519 public key. */
function isValidPublicKey(b64: string): boolean {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > 128) return false;
  try {
    const buf = Buffer.from(b64, 'base64');
    // Reject non-canonical base64 (Buffer is lenient) by round-tripping.
    return buf.length === 32 && buf.toString('base64') === b64;
  } catch {
    return false;
  }
}

// A bare `ws` server has no HTTP handler of its own — plain GETs (e.g. a
// platform health check on Render/Railway/etc.) would get ws's built-in 426
// "Upgrade Required" response, which most health checks treat as failure.
// Front it with a tiny HTTP server that answers those directly.
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    // CORS: the deployed client (a different origin) pings this to keep a
    // free-tier host from spinning down. Same allow-list as the WS origin
    // check — harmless either way since this route reveals nothing but "ok".
    const origin = req.headers.origin;
    if (typeof origin === 'string' && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_PAYLOAD,
  verifyClient: ({ origin }, done) => {
    // No Origin header => non-browser client (curl, native); allow it.
    // Browser clients send Origin; enforce the allow-list when configured.
    if (ALLOWED_ORIGINS.length === 0 || !origin || ALLOWED_ORIGINS.includes(origin)) {
      done(true);
      return;
    }
    done(false, 403, 'Forbidden origin');
  },
});

/** Per-socket state: the peer record once joined. */
const peerOf = new WeakMap<WebSocket, Peer>();

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function fail(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { type: 'error', code, message });
}

async function handleJoin(
  socket: WebSocket,
  roomId: string,
  publicKey: string,
  displayName: string,
): Promise<void> {
  if (peerOf.has(socket)) {
    fail(socket, 'bad-request', 'Already in a room');
    return;
  }
  if (!roomId || typeof roomId !== 'string' || roomId.length > 128) {
    fail(socket, 'invalid-room', 'Invalid room id');
    return;
  }
  if (!isValidPublicKey(publicKey)) {
    fail(socket, 'bad-request', 'Invalid public key');
    return;
  }
  // Cap the number of distinct rooms to bound memory against room-flood DoS.
  if (!getRoom(roomId) && roomCount() >= MAX_ROOMS) {
    fail(socket, 'bad-request', 'Server is at capacity, try again later');
    return;
  }
  const trimmedName = String(displayName ?? '').slice(0, 64) || 'Anonymous';
  const peer: Peer = {
    id: randomUUID(),
    socket,
    publicKey,
    displayName: trimmedName,
    roomId,
  };
  const result = joinRoom(roomId, peer);
  if (!result.ok) {
    fail(socket, 'room-full', `This room is full (max ${ROOM_MAX_PEERS} people)`);
    return;
  }
  peerOf.set(socket, peer);

  // Announce the newcomer to everyone else right away; don't make them wait
  // on the TURN fetch / DB round-trips below.
  for (const other of result.room.peers.values()) {
    if (other.id === peer.id) continue;
    send(other.socket, { type: 'peer-joined', peer: toIdentity(peer) });
  }

  // Record this member durably (survives disconnects) so others can still
  // address a message to them while they're offline. Merge the always-
  // available live roster (works even with no DB configured, matching
  // today's behavior exactly) with the durable one (adds previously-seen,
  // currently-offline members — a no-op when persistence isn't set up).
  await upsertRoomMember(roomId, publicKey, trimmedName).catch((err) =>
    console.error('[db] upsertRoomMember failed', err),
  );
  const durableMembers = await fetchRoomMembers(roomId, publicKey).catch((err) => {
    console.error('[db] fetchRoomMembers failed', err);
    return [];
  });
  const membersByKey = new Map<string, RoomMember>();
  for (const other of result.room.peers.values()) {
    if (other.id === peer.id) continue;
    membersByKey.set(other.publicKey, {
      publicKey: other.publicKey,
      displayName: other.displayName,
      online: true,
      peerId: other.id,
    });
  }
  for (const m of durableMembers) {
    if (!membersByKey.has(m.publicKey)) {
      membersByKey.set(m.publicKey, { ...m, online: false });
    }
  }
  const members = [...membersByKey.values()];

  const iceServers = await fetchTurnCredentials();
  const history = await fetchHistory(roomId, publicKey).catch((err) => {
    console.error('[db] fetchHistory failed', err);
    return [];
  });
  send(socket, { type: 'joined', selfId: peer.id, roomId, members, iceServers, history });
}

function handleLeave(socket: WebSocket): void {
  const peer = peerOf.get(socket);
  if (!peer) return;
  peerOf.delete(socket);
  const room = leaveRoom(peer);
  if (!room) return;
  for (const other of room.peers.values()) {
    send(other.socket, { type: 'peer-left', peerId: peer.id });
  }
}

/**
 * Relay a chat message, addressed by the recipient's permanent public key
 * (not a PeerId, which only exists while they're connected). If they're
 * currently online, deliver live; independently and unconditionally (not
 * gated on live delivery succeeding), persist a durable copy when the
 * client asked us to — that's what makes offline delivery and cross-device
 * history possible. Sending to yourself is just one more target here, same
 * as any other recipient — except we never live-deliver it back (the
 * sender already has their own optimistic local echo; this copy exists
 * purely to be persisted for later/other-device retrieval).
 */
async function handleRelay(socket: WebSocket, msg: Extract<ClientMessage, { type: 'relay' }>): Promise<void> {
  const peer = peerOf.get(socket);
  if (!peer) return fail(socket, 'not-in-room', 'Join a room first');
  if (!isValidPublicKey(msg.to)) return fail(socket, 'bad-request', 'Invalid recipient');
  const room = getRoom(peer.roomId);
  if (!room) return;

  const target = [...room.peers.values()].find((p) => p.publicKey === msg.to);
  if (target && target.id !== peer.id) {
    send(target.socket, { type: 'deliver', from: peer.publicKey, ciphertext: msg.ciphertext, nonce: msg.nonce });
  }
  if (msg.persist) {
    await persistMessage({
      roomId: peer.roomId,
      recipientPublicKey: msg.to,
      senderPublicKey: peer.publicKey,
      senderDisplayName: peer.displayName,
      ciphertext: msg.ciphertext,
      nonce: msg.nonce,
      sentAt: Date.now(),
    }).catch((err) => console.error('[db] persistMessage failed', err));
  }
}

function handleSignal(socket: WebSocket, msg: Extract<ClientMessage, { type: 'signal' }>): void {
  const peer = peerOf.get(socket);
  if (!peer) return fail(socket, 'not-in-room', 'Join a room first');
  const room = getRoom(peer.roomId);
  if (!room) return;
  const target = room.peers.get(msg.to);
  if (!target) return;
  send(target.socket, { type: 'signal', from: peer.id, signal: msg.signal });
}

wss.on('connection', (socket, req) => {
  const ip = clientIp(req);
  const open = connsPerIp.get(ip) ?? 0;
  if (open >= MAX_CONNS_PER_IP) {
    // Refuse before allocating any room/peer state.
    fail(socket, 'bad-request', 'Too many connections');
    socket.close(1008, 'Too many connections');
    return;
  }
  connsPerIp.set(ip, open + 1);
  stateOf.set(socket, { ip, alive: true, tokens: MSG_BURST, lastRefill: Date.now() });

  const cleanup = (): void => {
    handleLeave(socket);
    const n = (connsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) connsPerIp.delete(ip);
    else connsPerIp.set(ip, n);
  };

  socket.on('pong', () => {
    const st = stateOf.get(socket);
    if (st) st.alive = true;
  });

  socket.on('message', (data) => {
    if (!allowMessage(socket)) {
      // Over the rate budget — drop the frame and disconnect a flooding client.
      socket.close(1008, 'Rate limit exceeded');
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return fail(socket, 'bad-request', 'Malformed JSON');
    }
    switch (msg?.type) {
      case 'join':
        return handleJoin(socket, msg.roomId, msg.publicKey, msg.displayName);
      case 'leave':
        return handleLeave(socket);
      case 'relay':
        return handleRelay(socket, msg);
      case 'signal':
        return handleSignal(socket, msg);
      default:
        return fail(socket, 'bad-request', 'Unknown message type');
    }
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

// Heartbeat: ping every socket; terminate any that missed the previous round.
// Reaps half-open TCP connections that never send a clean close.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const st = stateOf.get(socket);
    if (st && !st.alive) {
      socket.terminate();
      continue;
    }
    if (st) st.alive = false;
    try {
      socket.ping();
    } catch {
      /* socket already gone */
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();
wss.on('close', () => clearInterval(heartbeat));

await initDb().catch((err) => {
  console.error('[db] initDb failed — history/offline delivery disabled for this run', err);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[signaling] listening on ws://${HOST ?? '0.0.0.0'}:${PORT}`);
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn('[signaling] ALLOWED_ORIGINS unset — accepting any browser origin. Set it in production.');
  }
});
