# Deploying Whisper: Render (server) + Vercel (client)

This is the recommended setup for a public, always-on deployment: the
signaling server runs on **Render** and the static client runs on **Vercel**.
They're two different origins, so the client talks to the server over a
`wss://` URL baked in at build time (`VITE_SIGNALING_URL`) instead of the
same-origin `/signaling` proxy used by the [nginx, single-host setup](deploy/README.md).

```
Browser ──https──▶ Vercel (static client)
   └──────wss────▶ Render (Node ws signaling server)
```

Repo layout is an npm workspace monorepo (`shared/`, `server/`, `client/`),
which both platforms are configured for via `render.yaml` and `vercel.json`
at the repo root — you mostly just need to set env vars.

## 1. Deploy the server to Render

**Option A — Blueprint (recommended):** in the Render dashboard, **New +** →
**Blueprint**, point it at this repo. Render reads `render.yaml` and creates
the `whisper-signaling` web service automatically.

**Option B — manual:** **New +** → **Web Service** → connect this repo, then set:

| Setting | Value |
|---|---|
| Runtime | Node |
| Root Directory | *(leave blank — repo root)* |
| Build Command | `npm install && npm run build --workspace=shared && npm run build --workspace=server` |
| Start Command | `npm run start --workspace=server` |
| Health Check Path | `/healthz` |

Either way, after the first deploy note the service URL, e.g.
`https://whisper-signaling.onrender.com` (ws origin: `wss://whisper-signaling.onrender.com`).

### Server environment variables

Set these in the Render dashboard (Environment tab). `PORT` is injected by
Render automatically — don't set it yourself.

| Var | Required | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | **Yes, in production** | Comma-separated list of browser Origins allowed to open a socket, e.g. your Vercel URL(s): `https://whisper-chat.vercel.app,https://whisper-chat-<hash>-<team>.vercel.app`. Left unset, any origin can connect — fine for testing, not for production. |
| `MAX_CONNS_PER_IP` | No | Default `30`. |
| `MAX_ROOMS` | No | Default `10000`. |
| `MSG_BURST` / `MSG_REFILL_PER_SEC` | No | Per-socket rate limit, defaults `60` / `30`. |

Render's free plan spins the service down after inactivity; the first
connection after idle takes a few seconds to wake it up (all in-memory rooms
are lost on spin-down/restart — expected for a stateless signaling server).

## 2. Deploy the client to Vercel

**New Project** → import this repo. Vercel reads `vercel.json` at the repo
root, so the defaults (install/build/output) are already correct — you don't
need to change the Root Directory or Framework Preset.

### Client environment variables

Set these in Vercel (Project Settings → Environment Variables) **before**
building — they're baked into the static bundle at build time, so changing
them requires a redeploy.

| Var | Required | Purpose |
|---|---|---|
| `VITE_SIGNALING_URL` | **Yes** | The Render server's `wss://` URL, e.g. `wss://whisper-signaling.onrender.com`. No trailing path. |
| `VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` | No | Only needed if calls fail across strict/mobile NATs. See [client/.env.example](client/.env.example) — **anything here is public** (readable in the client bundle), so use short-lived credentials, not static ones, for real production use. |

Deploy. Vercel gives you a URL like `https://whisper-chat.vercel.app`.

## 3. Close the loop: point the server's CORS allow-list at Vercel

Go back to Render → your service → Environment → set `ALLOWED_ORIGINS` to
your Vercel URL(s) from step 2 (comma-separated if you also test preview
deployments) → save (triggers a redeploy).

## 4. Verify

1. Open the Vercel URL in two browser tabs/devices, join the same room code.
2. Send a message and check it arrives (confirms the WebSocket + CORS setup).
3. Start a call (confirms WebRTC signaling relay + STUN/TURN if configured).
4. `curl https://<your-render-service>.onrender.com/healthz` → should return `ok`.

## Updating

Both platforms auto-deploy on push to your connected branch (`main` by
default). No manual steps needed after the initial setup — just push.

## Alternatives

- **Single VPS with nginx** (one HTTPS origin, no cross-origin config needed):
  see [deploy/README.md](deploy/README.md).
- **Local / LAN / quick tunnel for testing:** see [start-local.sh](start-local.sh)
  and the root [README.md](README.md).
