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

Known, documented limitations (see `SECURITY_AUDIT.md` for status):

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

### Upcoming: organization / managed mode

The roadmap adds multi-tenant organization features with a **per-org
encryption choice**. In *managed* mode conversations are deliberately
server-readable (the self-hosting org operates the server and owns its
support-chat data) — that mode trades the E2E invariant for shared-inbox
functionality, and will be documented explicitly here as it ships. E2E mode
keeps the full invariant above.

## Operational hardening for self-hosters

- Always front the server with TLS (see `deploy/nginx/whisper.conf` — HSTS,
  CSP, and security headers are included).
- Set `ALLOWED_ORIGINS` in production — an empty value allows any origin and
  is intended for development only (the server warns at startup).
- Use non-guessable room codes (the client generates ~59-bit CSPRNG codes).
- Keep dependencies current: `npm audit` is part of the release checklist.
