# Whisper — Security Audit & Remediation Log

Date: 2026-07-01
Scope: full codebase — crypto (`client/src/crypto`), signaling/relay server
(`server/src`), shared protocol (`shared/src`), client store/handlers, WebRTC
mesh (`client/src/rtc`), all React components, and deployment
(`deploy/`, `vite.config.ts`, `start-local.sh`, `client/index.html`).

`npm audit` reports **0 known dependency CVEs** across the workspace.

## What was already sound (kept as-is)

- Crypto primitives are used correctly: fresh 24-byte random nonce per message
  (`randombytes_buf`), authenticated `crypto_box` (X25519 + XSalsa20-Poly1305)
  with sender authentication, fail-closed decryption.
- The server stamps `from` from socket state, so peers **cannot spoof the sender
  id** of a relayed message.
- Relay/signal are scoped to the sender's own room.
- Message text is rendered through React (auto-escaped) — **no
  `dangerouslySetInnerHTML`, `innerHTML`, or `eval`**; no direct XSS sink.
- The server never logs or parses ciphertext; `.run/` logs are gitignored and
  contain no secrets. No hardcoded credentials/API keys anywhere in the repo.

---

## Findings (ranked) and remediation status

### 1. MITM: safety number existed but was never shown — server could silently decrypt all chat & calls
**Severity: High (core E2E-invariant break) · FIXED**

Every peer's X25519 public key is distributed *through the signaling server*.
The client encrypted to whatever key the server handed it, and the
`safetyNumber()` verification function was dead code (only referenced in tests).
A malicious/compromised server (or any hop: nginx, cloudflared, a network
attacker) could substitute its own key per peer and transparently
man-in-the-middle the "E2E" chat, with no way for users to detect it.

**Fix:**
- Surfaced the per-peer **safety number** in the roster with an out-of-band
  compare prompt and a "Mark as verified" action
  (`client/src/components/Roster.tsx`).
- Added **TOFU key pinning** (`client/src/crypto/trust.ts`): the first key seen
  for a given (room, name) is pinned; a later *different* key raises a loud
  "security number changed" alert and forces re-verification
  (`useChatStore.ts` — `ingestPeerKey`, `verifyPeer`, `keyAlerts`,
  `verifiedPeers`).

**Residual / follow-up:** the DTLS-SRTP media path is still authenticated only
by the same server-relayed identities; binding the SDP fingerprint into the
sealed channel would fully close the call-path MITM. Verification is
per-key/manual by design (no accounts).

### 2. Long-term private key in localStorage, no forward secrecy
**Severity: High · DOCUMENTED (architectural — not auto-fixed)**

The X25519 private key is persisted in `localStorage`
(`whisper.identity.v1`), readable by any same-origin script. Combined with a
static long-term key (no ratchet), a single theft decrypts all past *and*
future messages and enables impersonation.

**Mitigations applied now:** a strict CSP + security headers (finding #5) and
removal of all third-party script/font origins (finding #10) sharply reduce the
script-injection surface that could read `localStorage`.

**Recommended next (larger change):** store keys as non-extractable WebCrypto
`CryptoKey`s in IndexedDB, and adopt a Double-Ratchet session-key scheme for
forward secrecy. Tracked as a known limitation.

### 3. Silent call auto-answer could open a victim's microphone
**Severity: Medium-High · FIXED**

On any inbound WebRTC `offer` while not in a call, the client automatically ran
`getUserMedia({audio:true})`. If the origin already held a remembered mic
permission (typical after the first call), the browser granted it with no
prompt and streamed the victim's live audio to the offerer — triggerable by any
room member.

**Fix:** removed the auto-`getUserMedia`. An inbound offer now sets a ringing
`incomingCall` state and shows an Accept/Decline prompt
(`client/src/components/IncomingCall.tsx`); the mic is acquired **only** on
explicit Accept. Inbound media is neither played (the call stage is gated on
`inCall`) nor answered-with-media until accepted
(`useChatStore.ts` — `acceptCall`/`declineCall`, `signal` handler).

### 4. No auth / no Origin check; weak `Math.random` room codes
**Severity: Medium · FIXED**

The WebSocket server accepted any connection (no Origin check → cross-site
WebSocket hijacking) and room access rested entirely on the room code, which the
UI generated with `Math.random().toString(36).slice(2,8)` (~6 non-crypto
chars). Anyone who joins a room reads all plaintext (peers seal a copy to every
member), so guessable/enumerable codes are an eavesdropping risk.

**Fix:**
- Server `verifyClient` Origin allow-list via `ALLOWED_ORIGINS`
  (`server/src/index.ts`; wired in `deploy/whisper-signaling.service`).
- Room codes now use `crypto.getRandomValues` over an unambiguous alphabet,
  ~59 bits of entropy, grouped for readability (`client/src/views/JoinRoom.tsx`).
- Server also validates that the advertised public key is canonical base64
  decoding to exactly 32 bytes.

### 5. No CSP / security headers in nginx
**Severity: Medium (amplifies #2) · FIXED**

Production nginx served the app with no `Content-Security-Policy`, `HSTS`,
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, or
`Permissions-Policy`.

**Fix:** added a strict same-origin CSP (`script-src 'self'`, no third-party
sources), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy` locking camera/mic to self,
and HSTS (guidance-commented for real-cert deployments)
(`deploy/nginx/whisper.conf`).

### 6. Signaling-server DoS: unbounded rooms/connections, no rate limit, no heartbeat
**Severity: Medium · FIXED**

Any unseen `roomId` allocated a room held in memory forever; no per-IP
connection cap, no message rate limit, no ping/pong liveness check.

**Fix (`server/src/index.ts`, `server/src/rooms.ts`):**
- Global room cap (`MAX_ROOMS`, default 10k) + `roomCount()`.
- Per-IP live-connection cap (`MAX_CONNS_PER_IP`, default 30), honoring
  `X-Forwarded-For` behind the proxy.
- Per-socket token-bucket message rate limit (`MSG_BURST`/`MSG_REFILL_PER_SEC`);
  floods are disconnected.
- 30s ping/pong heartbeat that terminates dead/half-open sockets.

### 7. TURN credentials baked into the public client bundle
**Severity: Medium · DOCUMENTED (operational)**

`VITE_TURN_USERNAME`/`VITE_TURN_CREDENTIAL` are embedded verbatim in the shipped
JS and trivially extractable; long-lived static creds can be harvested for free
relay bandwidth.

**Fix:** documented the risk and the correct approach (short-lived per-session
credentials via coturn `use-auth-secret` REST/HMAC or Cloudflare TURN tokens) in
`client/.env.example`. Cannot be fully closed without a credential-minting
endpoint (out of scope for the static client).

### 8. Public tunnel exposes the Vite **dev** server
**Severity: Medium · DOCUMENTED**

`start-local.sh` tunnels `npm run dev:client` (the dev server, with
`allowedHosts:true` disabling host-header protection, plus HMR/eval/source-maps)
publicly. This is a convenience/dev path.

**Recommendation:** for any shared/public use, `npm run build` and serve the
static `dist/` behind the hardened nginx config in `deploy/` (which now carries
the CSP/headers). If the dev server must be tunneled, set an explicit
`allowedHosts` list instead of `true`.

### 9. Decrypted peer payload was unvalidated → a room member could white-screen other clients
**Severity: Low-Medium · FIXED**

`JSON.parse(plain) as ChatPayload` trusted the structure; a peer could seal
`{"kind":"text","text":{...}}`, and rendering a non-string `text` throws in
React with no error boundary → full UI crash for the victim.

**Fix:** added strict `isTextPayload`/`isTypingPayload` type guards (string
`text`, bounded length, finite `sentAt`) that drop malformed payloads
(`useChatStore.ts`), plus a React `ErrorBoundary` around the app
(`client/src/components/ErrorBoundary.tsx`, wired in `main.tsx`).

### 10. Third-party Google Fonts load leaked visits and widened CSP
**Severity: Low · FIXED**

The app fetched CSS/fonts from `fonts.googleapis.com`/`fonts.gstatic.com` on
every load, revealing each user's visit to Google and forcing external origins
into any CSP.

**Fix:** removed the Google Fonts `<link>`s; the UI falls back to the local
`system-ui` stack (already in `tailwind.config.js`). No third-party requests
remain, so CSP stays `'self'`.

### 11. Display names are unauthenticated (in-room impersonation)
**Severity: Low · PARTIALLY MITIGATED**

Any peer can choose any display name (inherent to the no-accounts design).

**Mitigation:** the roster now ties trust to the **verified key/safety number**,
not the name, and the TOFU pin is keyed on (room, name) so an impostor reusing a
known name with a different key raises the "security number changed" alert.

---

## Minor / informational
- Corrected a misleading comment in `client/src/crypto/index.ts` (base64 is the
  standard padded alphabet, not URL-safe).
- `deploy/nginx/whisper.conf`: consider an explicit modern cipher suite + OCSP
  stapling for further TLS hardening.

## Remaining follow-ups (not code-fixable in this pass)
1. Non-extractable key storage + forward secrecy / Double Ratchet (#2).
2. Bind DTLS-SRTP fingerprints into the authenticated channel to also
   authenticate the call media path (#1 residual).
3. Server-minted ephemeral TURN credentials (#7).
4. Serve the built static client (not the dev server) for public exposure (#8).

## Verification
- `server`: `npm run build` — passes.
- `client`: `npm run build` (tsc + vite) — passes.
- `client`: `npm test` — 9/9 pass.
