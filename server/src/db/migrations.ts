/**
 * Ordered, numbered schema migrations. Append-only: never edit an applied
 * migration — add a new one. Migration 001 is the original idempotent DDL
 * (CREATE ... IF NOT EXISTS), so databases created before the migration
 * system converge cleanly: applying 001 over an existing schema is a no-op.
 *
 * Privacy invariant note: `messages` and `conv_messages_e2e` carry ciphertext
 * only (there is deliberately no plaintext column), while `conv_messages`
 * (managed-mode org conversations) is deliberately plaintext — that split
 * keeps the two trust models machine-checkable at the schema level.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'legacy-rooms-messages-handles',
    sql: `
      CREATE TABLE IF NOT EXISTS room_members (
        room_id       TEXT NOT NULL,
        public_key    TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, public_key)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id                   BIGSERIAL PRIMARY KEY,
        room_id              TEXT NOT NULL,
        recipient_public_key TEXT NOT NULL,
        sender_public_key    TEXT NOT NULL,
        sender_display_name  TEXT NOT NULL,
        ciphertext           TEXT NOT NULL,
        nonce                TEXT NOT NULL,
        sent_at              BIGINT NOT NULL, -- ms, server receipt time (relay carries no client timestamp; the true send time is inside the encrypted payload, invisible to us)
        inserted_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS messages_recipient_idx
        ON messages (room_id, recipient_public_key, inserted_at);

      CREATE TABLE IF NOT EXISTS handles (
        handle       TEXT PRIMARY KEY,
        public_key   TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 2,
    name: 'org-tenancy',
    sql: `
      CREATE TABLE orgs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name            TEXT NOT NULL,
        slug            TEXT NOT NULL UNIQUE,
        encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('e2e', 'managed')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- v1: emails are globally unique so login needs no org picker.
      CREATE TABLE org_users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
        public_key    TEXT,          -- E2E-mode agent identity (base64 X25519), set from the dashboard
        disabled_at   TIMESTAMPTZ,   -- soft delete: keeps message attribution intact
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX org_users_org_idx ON org_users (org_id);

      -- Raw session tokens never touch the DB: only their SHA-256.
      CREATE TABLE org_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES org_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        ip         TEXT,
        user_agent TEXT
      );
      CREATE INDEX org_sessions_user_idx ON org_sessions (user_id);

      CREATE TABLE org_invites (
        token_hash TEXT PRIMARY KEY,
        org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
        created_by UUID NOT NULL REFERENCES org_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_by    UUID REFERENCES org_users(id),
        used_at    TIMESTAMPTZ
      );
      CREATE INDEX org_invites_org_idx ON org_invites (org_id);

      -- HMAC signing keys for store/marketplace-issued identity tokens. The
      -- secret is stored as-is by necessity (HMAC verification needs it);
      -- mitigations are DB access control + kid-based rotation + revocation.
      CREATE TABLE org_api_keys (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        kid        TEXT NOT NULL UNIQUE,
        secret     TEXT NOT NULL,
        label      TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX org_api_keys_org_idx ON org_api_keys (org_id);

      -- Anonymous B2C website visitors. Identified by a client-held secret,
      -- stored hashed (same rationale as session tokens).
      CREATE TABLE visitors (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        secret_hash  TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT 'Visitor',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (org_id, secret_hash)
      );

      CREATE TABLE conversations (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL CHECK (kind IN ('b2c', 'c2c')),
        encryption        TEXT NOT NULL CHECK (encryption IN ('e2e', 'managed')),
        external_key      TEXT,   -- canonicalized store-side conversation identity (C2C / identified B2C)
        context           JSONB,  -- e.g. { "listingId": "99", "title": "...", "url": "..." }
        status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
        assigned_agent_id UUID REFERENCES org_users(id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_message_at   TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX conversations_external_key_idx
        ON conversations (org_id, external_key) WHERE external_key IS NOT NULL;
      CREATE INDEX conversations_inbox_idx
        ON conversations (org_id, status, last_message_at DESC NULLS LAST);

      CREATE TABLE conversation_participants (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL CHECK (kind IN ('agent', 'visitor', 'external')),
        agent_id        UUID REFERENCES org_users(id),
        visitor_id      UUID REFERENCES visitors(id),
        external_id     TEXT,  -- store-side user id from a signed org token
        display_name    TEXT NOT NULL,
        public_key      TEXT,  -- E2E conversations only
        last_read_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (
          (kind = 'agent' AND agent_id IS NOT NULL AND visitor_id IS NULL AND external_id IS NULL) OR
          (kind = 'visitor' AND visitor_id IS NOT NULL AND agent_id IS NULL AND external_id IS NULL) OR
          (kind = 'external' AND external_id IS NOT NULL AND agent_id IS NULL AND visitor_id IS NULL)
        )
      );
      CREATE UNIQUE INDEX conversation_participants_agent_idx
        ON conversation_participants (conversation_id, agent_id) WHERE agent_id IS NOT NULL;
      CREATE UNIQUE INDEX conversation_participants_visitor_idx
        ON conversation_participants (conversation_id, visitor_id) WHERE visitor_id IS NOT NULL;
      CREATE UNIQUE INDEX conversation_participants_external_idx
        ON conversation_participants (conversation_id, external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX conversation_participants_conv_idx
        ON conversation_participants (conversation_id);

      -- Managed-mode messages: plaintext BY DESIGN (org chose server-readable
      -- conversations; the self-hosting org operates this database).
      CREATE TABLE conv_messages (
        id                    BIGSERIAL PRIMARY KEY,
        org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        conversation_id       UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_participant_id UUID NOT NULL REFERENCES conversation_participants(id),
        body                  TEXT NOT NULL,
        sent_at               BIGINT NOT NULL,
        inserted_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX conv_messages_conv_idx ON conv_messages (conversation_id, inserted_at);

      -- E2E-mode messages: ciphertext only, one row per recipient (mirrors
      -- the legacy "messages" table).
      CREATE TABLE conv_messages_e2e (
        id                   BIGSERIAL PRIMARY KEY,
        org_id               UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        recipient_public_key TEXT NOT NULL,
        sender_public_key    TEXT NOT NULL,
        sender_display_name  TEXT NOT NULL,
        ciphertext           TEXT NOT NULL,
        nonce                TEXT NOT NULL,
        sent_at              BIGINT NOT NULL,
        inserted_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX conv_messages_e2e_recipient_idx
        ON conv_messages_e2e (conversation_id, recipient_public_key, inserted_at);
    `,
  },
];
