# Changelog

## 0.2.0 — 2026-07-09

Whisper grows from a private E2E chat app into an **open-source,
self-hostable customer-chat platform for organizations** — while the
original private chat stays a first-class feature at `/`.

### Added

- **Docker self-hosting**: `docker compose up -d --build` runs Postgres +
  server + web on one origin (plus a stateless no-DB variant).
  → `docs/self-hosting.md`
- **Multi-tenant organizations**: registration, admin/agent roles, email +
  password auth (argon2id), single-use invite links (no SMTP needed),
  hashed session cookies with CSRF protection, staff management.
  → `docs/api.md`, `docs/data-model.md`
- **Per-org encryption mode**: `managed` (server-readable business
  conversations — shared inbox, handoff, history) or `e2e` (server-blind,
  sealed client-side). Enforced per frame on the wire; locked once
  conversations exist. → `docs/protocol.md`
- **Store & marketplace integration**: short-lived HS256 tokens signed by
  the store's backend identify customers and C2C buyer↔seller threads;
  anonymous B2C visitors need no integration at all.
  → `docs/integrations.md`
- **Agent dashboard** (`/dashboard.html`): login, live shared inbox with
  filters and assignment, conversation view with listing context,
  team/API-key/org settings. → `docs/dashboard.md`
- **Embeddable widget**: one `<script>` tag (3.4 kB loader) adds an
  iframe-isolated chat bubble to any store, with a JS API
  (`open/close/identify/on/destroy`), origin-pinned postMessage bridge,
  theming, and unread badges. → `docs/embedding.md`,
  `examples/store-demo.html`
- **Open-source hygiene**: CONTRIBUTING, SECURITY policy + threat model,
  Code of Conduct, annotated `.env.example`, CI (lint, build, tests,
  Postgres integration suite, Docker builds, dependency audit).
- Numbered DB migrations with an advisory-lock runner; the legacy schema is
  migration 001, so existing databases converge cleanly.
- `POST /api/auth/logout-all`; hourly janitor for expired sessions/invites.

### Unchanged (and regression-tested)

- The private E2E chat app: rooms, sealed relay, voice/video calls, safety
  numbers/TOFU pinning, @handles, optional ciphertext history. The legacy
  WS protocol is covered by an automated regression suite that runs with no
  database configured.

## 0.1.0

Initial private chat: E2E-encrypted rooms (libsodium `crypto_box`), WebRTC
mesh voice/video for 2–4, typing indicators, safety numbers, WhatsApp-style
UI, optional Postgres ciphertext history, nginx/Render/Vercel deploys.
