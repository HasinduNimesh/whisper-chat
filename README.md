# 🔒 Whisper — Open-Source, Self-Hostable Private Chat & Customer Messaging

Whisper is a **self-hostable chat platform** built on end-to-end encryption. Today
it ships a high-privacy **WhatsApp-style** web app for private rooms with E2E
text messaging and peer-to-peer **voice/video calls** (WebRTC mesh, DTLS-SRTP).
It is evolving into a full **customer-chat platform for organizations** — an
embeddable widget for online stores and marketplaces, with agent inboxes,
supporting both **B2C** (customer ↔ store agents) and **C2C** (buyer ↔ seller)
conversations. See the [Roadmap](#%EF%B8%8F-roadmap).

> No accounts. No phone numbers. No message history on the server (unless you
> opt in). Just share a room code and talk — or self-host it for your whole org.

---

## ✨ Features (today)

- 🔐 **End-to-end encryption** — every message is sealed per-recipient with
  libsodium `crypto_box` (X25519 + XSalsa20-Poly1305); only the intended peer can
  open it, and the sender is cryptographically authenticated.
- 📞 **Voice & video calls** — direct peer-to-peer WebRTC mesh (video up to 4,
  voice up to 20), with mute, camera toggle/swap, and a live call timer.
- ✍️ **Typing indicators** — sent over the same encrypted channel; the server
  never learns who's typing.
- 🛡️ **Safety numbers + TOFU key pinning** — deterministic, comparable
  fingerprints to detect a man-in-the-middle; key changes raise a loud alert.
- 🪪 **@handles & contacts** — optional public handle directory and client-side
  contacts with deterministic 1:1 rooms.
- 🗄️ **Optional history** — point the server at Postgres and it stores
  *ciphertext only* for cross-device/offline history; without a database it is
  fully in-memory and stateless.
- 💬 **WhatsApp-style UI** — dark theme, grouped bubbles, read-receipt ticks,
  presence, gradient avatars, polished join flow.

## 🏗️ Architecture

```
Client A ──ciphertext + SDP/ICE──▶  Signaling Server  ──▶ Client B / C / D
   └──────────────  WebRTC P2P media (DTLS-SRTP, E2E)  ──────────────┘
```

- **`client/`** — React + TypeScript + Vite web app. Does **all** encryption
  locally; plaintext and private keys never leave the device.
- **`server/`** — Minimal Node WebSocket signaling/relay server. Assigns peer
  ids, manages room membership, and forwards opaque ciphertext + WebRTC
  signaling. Optional Postgres persistence (ciphertext only).
- **`shared/`** — TypeScript protocol types shared by both, with the privacy
  invariant documented inline.

### 🔑 Cryptography

- Each device generates an **X25519 identity keypair** (libsodium `crypto_box`).
- Messages (and typing signals) are sealed **per-recipient** with authenticated
  public-key encryption (X25519 + XSalsa20-Poly1305).
- **Safety numbers** + **TOFU pinning** let people confirm there is no
  man-in-the-middle on the key exchange.
- Decryption/auth failures **fail closed** (the frame is dropped silently).

> **Privacy invariant:** the signaling server only ever sees ciphertext and
> routing metadata (room id, peer ids, public keys, SDP/ICE). Any field carrying
> user content on the wire is an opaque base64 blob sealed client-side first.

## 🧰 Tech stack

| Layer | Tech |
|---|---|
| Client | React 18, TypeScript, Vite, Tailwind CSS, Zustand |
| Crypto | libsodium (`libsodium-wrappers`) |
| Realtime | WebRTC (mesh, perfect negotiation), WebSocket signaling |
| Server | Node.js, `ws`, optional Postgres (`pg`) |
| Tests | Vitest |

## 📁 Project structure

```
.
├── client/                 # React + Vite web app (all crypto runs here)
│   └── src/
│       ├── components/      # UI: ChatHeader, Sidebar, MessageList, Composer, CallBar…
│       ├── views/           # JoinRoom, Room
│       ├── crypto/          # libsodium identity, seal/open, safety numbers (+ tests)
│       ├── rtc/             # WebRTC mesh / perfect negotiation (+ tests)
│       ├── signaling/       # typed WebSocket client
│       ├── store/           # Zustand store: connection, messages, calls, typing
│       └── lib/             # avatar colors, handles, typing labels
├── server/                 # WebSocket signaling/relay (+ optional Postgres)
├── shared/                 # Shared protocol types
├── deploy/                 # nginx config + systemd unit + deploy runbook
└── .github/workflows/      # CI (lint + build + test)
```

## 🚀 Getting started

Requires **Node.js 20+**.

```bash
npm install            # install all workspaces

npm run dev:server     # terminal 1 — signaling server on :8787
npm run dev:client     # terminal 2 — Vite dev server on :5173
```

Open <http://localhost:5173> in two or more tabs/browsers, enter the **same room
code**, and start chatting. Hit **Voice** or **Video** to start a call.

> Browsers only grant mic/camera access on `localhost` or over **HTTPS**. For LAN
> testing serve the client over HTTPS with `HTTPS=1 npm run dev:client`.

### ⚙️ Configuration

All server configuration is via environment variables — see
[`.env.example`](.env.example) for the full annotated list. Client build-time
variables live in [`client/.env.example`](client/.env.example).

## 🌍 Self-hosting / deployment

| Goal | How |
|---|---|
| **Quick public link** | Run server + client, then `cloudflared tunnel --url http://localhost:5173` (or `ngrok http 5173`). One origin, HTTPS, calls work. |
| **LAN (other devices)** | `HTTPS=1 npm run dev:client`, open `https://<your-ip>:5173` and accept the self-signed cert. |
| **Production (your server)** | nginx serves the built client + proxies `/signaling` to the Node server, with Let's Encrypt TLS and systemd. See [`deploy/README.md`](deploy/README.md). |
| **Render + Vercel (managed)** | Server on Render, client on Vercel, as two origins. See [`DEPLOYMENT.md`](DEPLOYMENT.md). |
| **Docker (recommended)** | `docker compose up -d --build` → full stack (Postgres + server + client) on one origin. See [`docs/self-hosting.md`](docs/self-hosting.md). |

The client targets same-origin `wss://<host>/signaling` automatically, so no
signaling env var is needed when a tunnel/nginx fronts both. Override with
`VITE_SIGNALING_URL` if you host the server separately.

### 📡 Reliable calls across networks (TURN)

STUN alone can't traverse strict/mobile NATs. Either set `METERED_API_KEY` +
`METERED_DOMAIN` on the server (credentials are minted per-join and never baked
into the bundle), or configure static TURN via `client/.env.example`.

## 🧪 Scripts

| Command | What it does |
|---|---|
| `npm run dev:server` | Run the signaling server (hot reload) |
| `npm run dev:client` | Run the web client (hot reload) |
| `npm test` | Run unit tests (Vitest) |
| `npm run lint` | Lint all workspaces |
| `npm run build` | Type-check + build all workspaces |
| `npm run format` | Prettier across the repo |

## 🗺️ Roadmap

Whisper is growing from a private chat app into an **organization-ready,
self-hostable customer-messaging platform**. Planned, in order:

- [x] Private E2E rooms, voice/video calls, handles/contacts, optional history
- [x] **Docker self-hosting** — one-command `docker compose up` (server + Postgres + client)
- [x] **Multi-tenant organizations** — orgs, admin/agent roles, invites
      ([docs/api.md](docs/api.md), [docs/data-model.md](docs/data-model.md))
- [x] **Per-org encryption mode** — orgs choose full **E2E** conversations *or*
      server-readable **managed** conversations (enables shared inboxes,
      agent handoff, and history the org controls) ([docs/protocol.md](docs/protocol.md))
- [x] **Store & marketplace integration** — signed-token identity (HMAC JWT) so
      a shop or marketplace backend can securely tell Whisper who is talking:
      **B2C** (visitor/customer ↔ the org's agents) and **C2C**
      (buyer ↔ seller about a listing) ([docs/integrations.md](docs/integrations.md))
- [x] **Agent dashboard** — login, shared inbox, assignment, conversation view
      ([docs/dashboard.md](docs/dashboard.md))
- [ ] **Embeddable widget** — one `<script>` tag adds a floating chat bubble
      (iframe-isolated) to any store, plus a documented JS API

### Non-goals for v1 (deliberately deferred)

Email/SMTP sending, chatbots/auto-replies, file uploads, supervisor live-view,
billing/plans, SSO/OAuth, webhooks, canned responses, i18n, and horizontal
scaling (single-node in-memory rooms are a documented limit).

## 🤝 Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for
the workspace layout, coding standards, and branch workflow, and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community expectations.

## 🛡️ Security

See [`SECURITY.md`](SECURITY.md) for the threat model, reporting instructions,
and [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md) for the full audit log.

## 📄 License

[MIT](LICENSE) © HasinduNimesh
