import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// libsodium-wrappers' exports map sends ESM resolvers to a broken `.mjs` build
// (its `./libsodium.mjs` import is not shipped). Point directly at the working,
// self-contained CJS build via an absolute path, which bypasses the exports map.
// node_modules is hoisted to the workspace root (one level up from client/).
const sodiumCjs = path.resolve(
  here,
  '../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js',
);

// The signaling server runs as a plain ws:// process on :8787. To expose the app
// over HTTPS on the LAN (required for getUserMedia / calls on non-localhost), we
// serve the client with a self-signed cert and proxy the WebSocket through the
// same origin at /signaling — so the browser only ever sees one HTTPS host and
// one cert to trust, and signaling rides wss:// automatically.
const SIGNALING_TARGET = process.env.SIGNALING_TARGET ?? 'ws://localhost:8787';

// HTTPS is needed for getUserMedia only when the page is served directly (LAN).
// Behind a tunnel (ngrok / cloudflared) the tunnel terminates HTTPS for us, so
// we serve plain HTTP locally. Opt in with HTTPS=1 for the self-signed LAN flow.
const useHttps = process.env.HTTPS === '1' || process.env.HTTPS === 'true';

export default defineConfig({
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  resolve: {
    alias: {
      'libsodium-wrappers': sodiumCjs,
    },
  },
  build: {
    rollupOptions: {
      // Multi-entry: the private chat app (index) + the org staff dashboard.
      // The legacy index entry is untouched — the original app cannot regress.
      input: {
        index: path.resolve(here, 'index.html'),
        dashboard: path.resolve(here, 'dashboard.html'),
      },
    },
  },
  server: {
    host: true, // bind 0.0.0.0 so other devices / tunnels can reach it
    port: 5173,
    // Tunnels use random hostnames; Vite blocks unknown hosts unless allowed.
    allowedHosts: true,
    proxy: {
      '/signaling': {
        target: SIGNALING_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
