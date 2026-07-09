/**
 * Server entrypoint: one HTTP server carrying
 *  - the REST surface (health, @handles, org /api) — http/app.ts
 *  - the WebSocket signaling/relay for rooms + conversations — ws.ts
 *
 * The privacy invariant (see shared/src/index.ts): for legacy rooms and E2E
 * conversations this process deliberately cannot read message content —
 * payloads arrive already sealed and are forwarded byte-for-byte. Managed
 * conversations are server-readable by the owning org's explicit choice.
 */
import { createServer } from 'node:http';
import { ALLOWED_ORIGINS, HOST, PORT } from './config.js';
import { initDb } from './db/index.js';
import { createRequestListener } from './http/app.js';
import { attachSignaling } from './ws.js';

const httpServer = createServer(createRequestListener());
attachSignaling(httpServer);

await initDb().catch((err) => {
  console.error('[db] initDb failed — history/offline delivery disabled for this run', err);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[signaling] listening on ws://${HOST ?? '0.0.0.0'}:${PORT}`);
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn('[signaling] ALLOWED_ORIGINS unset — accepting any browser origin. Set it in production.');
  }
});
