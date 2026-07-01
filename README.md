# 🔒 Whisper — Private E2E-Encrypted Chat & Calls

A high-privacy, **WhatsApp-style** web app for **2–4 people** with end-to-end
encrypted text messaging and peer-to-peer **voice/video calls** (WebRTC mesh,
DTLS-SRTP). The server only ever relays **ciphertext** and connection metadata —
it can never read your messages or media.

> No accounts. No phone numbers. No message history on the server. Just share a
> room code and talk.

---

## ✨ Features

- 🔐 **End-to-end encryption** — every message is sealed per-recipient with
  libsodium `crypto_box` (X25519 + XSalsa20-Poly1305); only the intended peer can
  open it, and the sender is cryptographically authenticated.
- 📞 **Voice & video calls** — direct peer-to-peer WebRTC mesh for up to 4 people,
  with mute, camera toggle, and a live call timer. Peers auto-join an active call.
- ✍️ **Typing indicators** — see when others are typing (sent over the same
  encrypted channel — the server never learns who's typing).
- 🛡️ **Safety numbers** — deterministic, comparable fingerprints to detect a
  man-in-the-middle.
- 💬 **WhatsApp-style UI** — dark theme, chat wallpaper, grouped bubbles with
  tails, read-receipt ticks, presence, gradient avatars, and a polished join flow.
- 🕸️ **Tiny, stateless server** — in-memory rooms only; nothing is persisted.

## 🏗️ Architecture

```
Client A ──ciphertext + SDP/ICE──▶  Signaling Server  ──▶ Client B / C / D
   └──────────────  WebRTC P2P media (DTLS-SRTP, E2E)  ──────────────┘
```

- **`client/`** — React + TypeScript + Vite web app. Does **all** encryption
  locally; plaintext and private keys never leave the device.
- **`server/`** — Minimal Node WebSocket signaling/relay server. Assigns peer
  ids, manages 2–4 room membership, and forwards opaque ciphertext + WebRTC
  signaling. Ciphertext only.
- **`shared/`** — TypeScript protocol types shared by both, with the privacy
  invariant documented inline.

### 🔑 Cryptography

- Each device generates an **X25519 identity keypair** (libsodium `crypto_box`).
- Messages (and typing signals) are sealed **per-recipient** with authenticated
  public-key encryption (X25519 + XSalsa20-Poly1305), so only the intended peer
  can open them and the sender is authenticated.
- **Safety numbers** let two people confirm there is no man-in-the-middle on the
  key exchange.
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
| Server | Node.js, `ws` |
| Tests | Vitest |

## 📁 Project structure

```
.
├── client/                 # React + Vite web app (all crypto runs here)
│   ├── src/
│   │   ├── components/      # UI: ChatHeader, Sidebar, MessageList, Composer, CallBar, CallStage…
│   │   ├── views/           # JoinRoom, Room
│   │   ├── crypto/          # libsodium identity, seal/open, safety numbers (+ tests)
│   │   ├── rtc/             # WebRTC mesh / perfect negotiation (+ tests)
│   │   ├── signaling/       # typed WebSocket client
│   │   ├── store/           # Zustand store: connection, messages, calls, typing
│   │   └── lib/             # avatar colors, typing labels
├── server/                 # WebSocket signaling/relay (in-memory rooms)
├── shared/                 # Shared protocol types
├── deploy/                 # nginx config + systemd unit + deploy runbook
└── .claude/agents/         # Project AI agents (UX, security, quality, deploy)
```

## 🚀 Getting started

```bash
npm install            # install all workspaces

npm run dev:server     # terminal 1 — signaling server on :8787
npm run dev:client     # terminal 2 — Vite dev server on :5173
```

Open <http://localhost:5173> in two or more tabs/browsers, enter the **same room
code**, and start chatting. Hit **Voice** or **Video** to start a call — peers in
the room auto-join, and you can mute or toggle your camera mid-call.

> Browsers only grant mic/camera access on `localhost` or over **HTTPS**. For LAN
> testing serve the client over HTTPS with `HTTPS=1 npm run dev:client`.

## 🌍 Share it / deploy

| Goal | How |
|---|---|
| **Quick public link** | Run server + client, then `cloudflared tunnel --url http://localhost:5173` (or `ngrok http 5173`). One origin, HTTPS, calls work. Link lives while your machine runs. |
| **LAN (other devices)** | `HTTPS=1 npm run dev:client`, open `https://<your-ip>:5173` and accept the self-signed cert. |
| **Production (your server)** | nginx serves the built client + proxies `/signaling` to the Node server, with Let's Encrypt TLS and systemd. See [`deploy/README.md`](deploy/README.md). |
| **Render + Vercel (managed, no server to babysit)** | Server on Render, client on Vercel, as two origins. See [`DEPLOYMENT.md`](DEPLOYMENT.md). |

The client targets same-origin `wss://<host>/signaling` automatically, so no
signaling env var is needed when a tunnel/nginx fronts both. Override with
`VITE_SIGNALING_URL` if you host the server separately.

### 📡 Reliable calls across networks (TURN)

STUN alone can't traverse strict/mobile NATs. To make calls connect for everyone,
copy `client/.env.example` → `client/.env.local`, add TURN credentials (a free
testing option is documented there), and rebuild/restart the client. The client
adds them to its WebRTC ICE config automatically.

## 🧪 Scripts

| Command | What it does |
|---|---|
| `npm run dev:server` | Run the signaling server (hot reload) |
| `npm run dev:client` | Run the web client (hot reload) |
| `npm test` | Run client unit tests (Vitest) |
| `npm run lint` | Lint all workspaces |
| `npm run build` | Type-check + build all workspaces |
| `npm run format` | Prettier across the repo |

## ✅ Testing

Unit tests cover the security-critical pure logic — the crypto round-trip /
tamper rejection / safety numbers, and the WebRTC perfect-negotiation tie-break:

```bash
npm test
```

## 🤖 Project agents

`.claude/agents/` ships four task-specific [Claude Code](https://claude.com/claude-code)
subagents tailored to this codebase: `ux-ui-engineer`, `security-auditor`,
`code-quality-reviewer`, and `deployment-engineer`.

## 🗺️ Status / Roadmap

- [x] M0 Scaffold & tooling
- [x] M1 Signaling server + room join/presence
- [x] M2 E2E encrypted text chat (+ typing indicators)
- [x] M3 Voice calls (WebRTC mesh)
- [x] M4 Video calls
- [ ] M5 Security hardening (safety-number UI, key rotation, IndexedDB keystore)
- [ ] M6 UI/UX polish + full QA (Playwright e2e)

## 🔏 Privacy notes (v1)

- No accounts, no message persistence on the server (rooms are in-memory only).
- Identity private keys are stored in `localStorage` in v1; M5 moves these to a
  non-extractable IndexedDB keystore.
- Anyone with a room code can join that room — use non-guessable codes.

## 📄 License

[MIT](LICENSE) © HasinduNimesh
