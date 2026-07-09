# Self-hosting Whisper with Docker

The repo ships a complete containerized stack: **Postgres + signaling server +
web client** behind one nginx origin. This is the recommended way to self-host.

## Quick start

Requires Docker with the compose plugin.

```bash
git clone <this-repo>
cd whisper
docker compose up -d --build
```

Open <http://localhost:8080>. That's it — the web container serves the client
and proxies `/signaling` (WebSocket) and the REST endpoints to the server
container, so the browser only ever sees one origin.

Prefer maximum privacy with **no persistence at all** (no message history, no
@handle directory)? Run the DB-less variant instead:

```bash
docker compose -f docker-compose.no-db.yml up -d --build
```

## Configuration

Set these in a `.env` file next to `docker-compose.yml` (compose reads it
automatically) or export them in your shell:

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | `whisper` | **Change this.** Postgres is not published to the host, but defense-in-depth says don't run defaults. |
| `ALLOWED_ORIGINS` | `http://localhost:8080` | Comma-separated browser origins allowed to connect. Set to your public `https://` origin in production. |
| `WEB_PORT` | `8080` | Host port the web UI binds to. |
| `METERED_API_KEY` / `METERED_DOMAIN` | — | Optional [Metered.ca](https://www.metered.ca/) TURN credentials so calls connect across strict NATs. Minted per-join server-side; never baked into the client bundle. |

The full annotated list of server environment variables is in
[`.env.example`](../.env.example) — anything there can be added to the
`server:` service's `environment:` block.

## What each container does

| Service | Image | Role |
|---|---|---|
| `web` | nginx 1.27 + built client | Serves the static app; proxies `/signaling`, `/healthz`, `/handles`, `/api` to `server`. Security headers included. |
| `server` | Node 22 (runs TS via `tsx`) | WebSocket signaling/relay. Sees **ciphertext only** for E2E rooms. Runs as non-root; has a `/healthz` healthcheck. |
| `postgres` | postgres:16-alpine | Optional history: ciphertext + routing metadata, never plaintext. Internal network only. |

## Production: TLS

The stack listens on plain HTTP — terminate TLS in front of it. Browsers
require HTTPS for mic/camera access (calls), so this is effectively mandatory.

**Option A — Caddy (easiest, auto-HTTPS):**

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**Option B — host nginx + certbot:** proxy `https://chat.example.com` →
`http://127.0.0.1:8080` and add HSTS at that layer. The TLS-parts of
[`deploy/nginx/whisper.conf`](../deploy/nginx/whisper.conf) show a working
reference (server names, certificates, HSTS header).

Then set `ALLOWED_ORIGINS=https://chat.example.com` and restart:

```bash
ALLOWED_ORIGINS=https://chat.example.com docker compose up -d
```

**Reliable calls:** across strict/mobile NATs you'll also want TURN — set
`METERED_API_KEY`/`METERED_DOMAIN` (or run your own coturn and configure static
credentials via `client/.env.example` before building).

## Operations

```bash
docker compose logs -f server     # server logs (never contain message content)
docker compose ps                 # health status of all services
docker compose pull && docker compose up -d --build   # upgrade
docker compose down               # stop (add -v to also delete history)
```

Postgres data lives in the `pgdata` named volume. Back it up with your usual
`pg_dump` routine if history matters to you; remember it only ever contains
ciphertext and routing metadata.

## Non-Docker alternatives

- **Bare VPS (nginx + systemd):** [`deploy/README.md`](../deploy/README.md)
- **Render + Vercel (managed):** [`DEPLOYMENT.md`](../DEPLOYMENT.md)
- **Quick tunnel from your machine:** `./start-local.sh` (cloudflared)
