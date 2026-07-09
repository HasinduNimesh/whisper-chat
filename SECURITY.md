# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via GitHub's **Security → Report a vulnerability**
(private security advisory) on this repository, or email the maintainer at
<hasindunimesh89@gmail.com> with:

- A description of the issue and its impact
- Steps to reproduce (a proof-of-concept is ideal)
- Affected component (`client/`, `server/`, `shared/`, deployment configs)

You can expect an acknowledgement within **72 hours**. Please allow a
reasonable window for a fix before public disclosure; credit is given in the
release notes unless you prefer otherwise.

## Supported versions

Only the latest release / `main` branch receives security fixes.

## Threat model (summary)

Whisper's core promise: **for E2E rooms, the server is untrusted for
confidentiality.** It only ever sees ciphertext and routing metadata (room id,
peer ids, public keys, SDP/ICE). Full details and the audit log live in
[`SECURITY_AUDIT.md`](SECURITY_AUDIT.md).

What the design defends against:

- **A compromised or malicious server reading messages** — impossible for E2E
  rooms: content is sealed per-recipient with libsodium `crypto_box`
  (X25519 + XSalsa20-Poly1305) before it touches the wire.
- **Server-side key substitution (MITM)** — detectable: safety numbers are
  surfaced in the UI, and TOFU key pinning raises a loud alert when a peer's
  key changes.
- **Sender spoofing** — the server stamps relay frames with the sender identity
  from authenticated socket state; ciphertexts are authenticated to the
  sender's key.
- **Signaling abuse / DoS** — per-socket token-bucket rate limiting, per-IP
  connection caps, global room caps, payload size limits, origin allow-list,
  heartbeat reaping.
- **XSS** — all message content renders through React text nodes; no
  `dangerouslySetInnerHTML` / `innerHTML` / `eval` anywhere.

Known, documented limitations (numbered findings in `SECURITY_AUDIT.md`):

- Identity private keys are stored in browser `localStorage` (plaintext). A
  successful XSS or device compromise exposes them. Passphrase-protected
  export/import exists; a non-extractable keystore and forward secrecy
  (Double Ratchet) are on the roadmap.
- There is no message forward secrecy yet — one long-term key decrypts a
  device's full history.
- Display names and @handles are convenience labels, **not** proof of
  identity; trust is anchored to the verified public key.
- Call media (DTLS-SRTP) is end-to-end between peers but authenticated via
  server-relayed identities; verify safety numbers for high-stakes calls.
- If you enable Postgres persistence, the server durably stores **ciphertext
  and routing metadata** (never plaintext). Metadata (who talks to whom, when)
  is visible to whoever operates the database.

## Organization features: the two-mode threat model

Multi-tenant customer chat (orgs, agents, store widget) adds a second trust
model. Each org chooses at creation (locked once conversations exist):

| | **E2E conversations** | **Managed conversations** |
|---|---|---|
| Server sees message content | Never (ciphertext relay + ciphertext-only storage; plaintext `send` frames are rejected with `wrong-mode`) | Yes, **by the org's explicit choice** — the org self-hosts the server and owns its support-chat data (shared inbox, handoff, history) |
| Keys | Per agent/visitor, in each browser's storage | n/a (TLS + session/token auth) |
| Sealed `relay` frames | The only content path | Rejected (`wrong-mode`) — modes can never silently mix |

Controls that hold in **both** modes (tenant isolation & auth):

- Every org-scoped query is filtered by `org_id` in SQL (never post-filtered
  in JS); the integration suites assert cross-org blindness for reads and
  writes, over both REST and WebSocket.
- Staff auth: argon2id password hashes; 32-byte session tokens stored only
  as SHA-256; `HttpOnly; SameSite=Lax; Secure` cookies with sliding expiry;
  uniform login errors + dummy-verify timing equalization (no account
  enumeration); per-IP and per-email rate limits; `logout-all` endpoint;
  hourly janitor purging expired sessions/invites.
- CSRF: state-changing dashboard requests require `X-Requested-With: fetch`
  (forces a CORS preflight cross-site) plus an Origin allow-list/same-host
  check; credentialed CORS reflects allow-listed origins only.
- Store tokens: HS256 JWTs verified with the algorithm pinned, `kid`→org
  lookup, revocation honored, lifetime capped at 10 minutes, and the `conv`
  claim bound to exactly one conversation. Signing secrets exist only in
  your database and the store's backend — never in any client bundle.
- Invite links are single-use, 7-day, stored hashed.
- Widget embedding: the iframe page is cookie-free and is the only page
  allowed in cross-origin frames; the postMessage bridge pins exact origins
  on both ends and identity tokens never appear in URLs. Visitor secrets
  live in the iframe origin's (partitioned) storage, hashed at rest.

Documented, accepted tradeoffs:

- **Org API-key secrets are stored raw** in Postgres — HMAC verification
  requires the key. Mitigations: DB access control, `kid` rotation,
  revocation, one-time display.
- **Agent/visitor E2E keys live in browser localStorage** (same caveat as
  the private app's identity, finding #2 below).
- **Managed mode stores plaintext** — that is the feature; protect the
  database accordingly (disk encryption, access control, backups).

## Operational hardening for self-hosters

- Always front the server with TLS (see `deploy/nginx/whisper.conf` — HSTS,
  CSP, and security headers are included).
- Set `ALLOWED_ORIGINS` in production — an empty value allows any origin and
  is intended for development only (the server warns at startup).
- Use non-guessable room codes (the client generates ~59-bit CSPRNG codes).
- Keep dependencies current: `npm audit` is part of the release checklist.
