# HTTP API

Base URL: your server origin (e.g. `https://chat.example.com`). All bodies are
JSON. Organization features require `DATABASE_URL` — without it, `/api/*`
responds `503`.

## Conventions

- **Auth cookie**: staff endpoints use the `whisper_session` cookie
  (HttpOnly, `SameSite=Lax`, `Secure` unless `COOKIE_SECURE=false`). Sessions
  slide: any authenticated request extends the 30-day expiry.
- **CSRF**: every state-changing request must send the header
  `X-Requested-With: fetch`. Requests with a browser `Origin` outside
  `ALLOWED_ORIGINS` (or the request host) are rejected 403.
- **Rate limits**: credential endpoints are limited per IP (and login also
  per email) to `AUTH_RATE_LIMIT`/min (default 10) → `429`.
- **Errors**: `{ "error": "human-readable message" }` with a suitable status.
  Login failures are always `401 {"error":"Invalid credentials"}` — the API
  never reveals whether an email exists.

## Health

| Route | Notes |
|---|---|
| `GET /` , `GET /healthz` | `200 ok` (text). Used by platform health checks. |

## Organizations & staff auth

### `POST /api/orgs` — register an organization
Gated by `ALLOW_ORG_SIGNUP` (default on; set `false` for closed instances).

```json
{
  "orgName": "Acme Store", "slug": "acme-store",
  "encryptionMode": "managed",
  "email": "owner@acme.example", "password": "…", "displayName": "Sam"
}
```

- `encryptionMode`: `"managed"` (server-readable business conversations —
  shared inbox, handoff) or `"e2e"` (end-to-end encrypted conversations —
  the server can never read them). **Locked once the org has conversations.**
- `201` → `{ org, user }` + session cookie. `409` on taken slug/email.

### `POST /api/auth/login`
`{ "email": "…", "password": "…" }` → `200 { org, user }` + cookie, or `401`.

### `POST /api/auth/logout`
Destroys the session, expires the cookie. → `200 { ok: true }`

### `GET /api/auth/me`
→ `200 { org, user }` or `401`.

### `PATCH /api/auth/me/public-key`
E2E-mode agents publish their X25519 identity key (base64, 32 bytes):
`{ "publicKey": "…" }` → `200`.

## Invites (staff onboarding — no SMTP needed)

### `POST /api/invites` *(admin)*
`{ "role": "agent" | "admin" }` → `201 { token, role, expiresAt }`.
Compose the URL yourself (e.g. `https://your-host/dashboard/#/invite/<token>`)
and hand it to the teammate. Single-use, 7-day expiry, only its hash is stored.

### `GET /api/invites/:token`
Public peek for the accept page → `200 { orgName, role }` or `404`.

### `POST /api/invites/accept`
`{ "token", "email", "password", "displayName" }` →
`201 { org, user }` + session cookie. `409` if the invite was already used or
the email is taken (an email conflict releases the invite for retry).

## Org administration

### `PATCH /api/org/settings` *(admin)*
`{ "name"?: "…", "encryptionMode"?: "e2e" | "managed" }` → `200 { org }`.
`409` when trying to change the encryption mode after conversations exist.

### `GET /api/org/agents` *(any staff)*
→ `200 { agents: [{ id, email, displayName, role, publicKey, disabled, createdAt }] }`

### `DELETE /api/org/agents/:id` *(admin)*
Soft-disables the account (message attribution survives) and kills all its
sessions. Self-disable is rejected (`400`). → `200 { ok: true }`

## @handle directory (legacy private-chat app)

| Route | Notes |
|---|---|
| `POST /handles/claim` | `{ handle, publicKey, displayName }` → `200` / `409` taken / `503` no DB |
| `GET /handles/:handle` | → `200 { publicKey, displayName }` / `404` / `503` |

Rate-limited per IP (`HANDLE_RATE_LIMIT`/min, default 20).

## Security design notes

- Passwords: argon2id (19 MiB, t=2, p=1). Unknown-email logins still perform
  a dummy argon2 verification so response timing can't enumerate accounts.
- Session & invite tokens: 32 random bytes; the DB stores only SHA-256
  hashes, so a database leak cannot be replayed as live credentials.
- CSRF: the `X-Requested-With` requirement forces a CORS preflight for any
  cross-site request, which unlisted origins fail; `SameSite=Lax` cookies
  back-stop it. Credentialed CORS reflects **allow-listed** origins only.
- RBAC: `admin` manages staff/invites/settings; `agent` reads the roster and
  (in later milestones) works the inbox. All staff queries are org-scoped in
  SQL — see [`data-model.md`](data-model.md).
