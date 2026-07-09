# Data model

The server runs happily with **no database at all** (fully in-memory, nothing
persisted). Point it at Postgres via `DATABASE_URL` and two feature sets light
up:

1. **Legacy private-chat persistence** — ciphertext history, durable room
   membership, the @handle directory (migration 001).
2. **Organization / customer-chat tenancy** — orgs, staff, sessions,
   invites, API keys, visitors, conversations, messages (migration 002).

Migrations are numbered, applied in order inside per-migration transactions,
recorded in `schema_migrations`, and guarded by a Postgres advisory lock so
several server instances can boot concurrently. Migration 001 is the original
idempotent DDL, so pre-migration databases converge cleanly.
Code: `server/src/db/` (`migrations.ts`, `migrate.ts`, one repo module per
aggregate).

## Tenant isolation

**Every org-scoped repo function takes `orgId` as its first parameter and
scopes its SQL with `org_id = $1`.** Isolation lives in the query, never in
JS post-filtering. The integration suite
(`server/src/db/tenancy.test.ts`) asserts cross-org blindness for reads and
writes. The only deliberate exceptions:

- `getUserForLogin(email)` — the email locates the org (emails are globally
  unique in v1 so login needs no org picker).
- `getApiKeyForVerify(kid)` — the key id locates the org during token
  verification.
- Session token lookup — the token hash locates the user (and thus the org).

## Entity relationship sketch

```
orgs ─┬─< org_users ──< org_sessions
      │       └──────< org_invites (created_by)
      ├─< org_api_keys
      ├─< visitors
      └─< conversations ─┬─< conversation_participants >── org_users / visitors / (external_id)
                         ├─< conv_messages       (managed mode: plaintext)
                         └─< conv_messages_e2e   (E2E mode: ciphertext per recipient)

room_members / messages / handles   (legacy private-chat app, org-free)
```

## Tables (migration 002)

| Table | Purpose | Notable columns / constraints |
|---|---|---|
| `orgs` | Tenant root | `slug` unique; `encryption_mode ∈ {e2e, managed}` — mutable only while the org has **no** conversations (enforced in SQL) |
| `org_users` | Staff (admins/agents) | `email` globally unique; `role ∈ {admin, agent}`; `public_key` for E2E-mode agents; `disabled_at` soft delete (keeps message attribution) |
| `org_sessions` | Staff login sessions | PK = `token_hash` (SHA-256; raw token only ever lives in the cookie); sliding `expires_at` |
| `org_invites` | One-time staff invite links | PK = `token_hash`; single-use (`used_at`), expiring |
| `org_api_keys` | HMAC keys for store-signed identity tokens | `kid` unique; `secret` stored raw *by necessity* (HMAC verify) — mitigated by rotation + revocation + one-time display |
| `visitors` | Anonymous B2C widget users | `(org_id, secret_hash)` unique; secret held client-side, hashed at rest |
| `conversations` | Unit of customer chat | `kind ∈ {b2c, c2c}`; `encryption` snapshotted from the org at creation; `external_key` = canonicalized store-side identity, unique per org; `context` JSONB (listing info); `status`, `assigned_agent_id` |
| `conversation_participants` | Who's in a conversation | Exactly one of `agent_id` / `visitor_id` / `external_id` per row (CHECK); partial unique indexes make joins idempotent |
| `conv_messages` | **Managed-mode** messages | Plaintext `body` — the org explicitly chose server-readable conversations |
| `conv_messages_e2e` | **E2E-mode** messages | Ciphertext + nonce, one row per recipient key; no plaintext column exists |

The two message tables make the trust split machine-checkable at the schema
level: the plaintext table has no ciphertext column and vice-versa.

## Legacy tables (migration 001)

| Table | Purpose |
|---|---|
| `room_members` | Durable room membership (public key + display-name snapshot) |
| `messages` | Per-recipient **ciphertext** history for classic rooms |
| `handles` | Global @handle → public key directory |

## What is deliberately NOT stored

- Plaintext for any E2E room/conversation (no column for it exists).
- Raw session/invite/visitor tokens — SHA-256 only.
- Passwords — argon2id hashes only (`password_hash`).

## Running the integration tests

```bash
# throwaway database
docker run -d --rm --name whisper-test-db -e POSTGRES_PASSWORD=test \
  -p 55432:5432 postgres:16-alpine

TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres \
  npm run test --workspace=server

docker rm -f whisper-test-db
```

Without `TEST_DATABASE_URL` the integration suite is skipped (unit tests still
run). The vitest config maps `TEST_DATABASE_URL` → `DATABASE_URL` and blanks
any inherited `DATABASE_URL`, so a test run can never touch a real database.
