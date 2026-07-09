/**
 * Conversation message storage — one function set per trust model:
 *
 * - Managed mode (`conv_messages`): plaintext, one row per message, readable
 *   by the org that chose server-readable conversations.
 * - E2E mode (`conv_messages_e2e`): ciphertext only, one row per recipient,
 *   mirroring the legacy `messages` table. The server cannot read these.
 */
import { requirePool } from './pool.js';
import type { HistoryEntry } from '@private-chat/shared';

const HISTORY_LIMIT = 200;

export interface ManagedMessage {
  id: string;
  conversationId: string;
  senderParticipantId: string;
  body: string;
  sentAt: number;
}

export async function insertManagedMessage(
  orgId: string,
  input: { conversationId: string; senderParticipantId: string; body: string; sentAt: number },
): Promise<ManagedMessage> {
  const res = await requirePool().query<{ id: string }>(
    `INSERT INTO conv_messages (org_id, conversation_id, sender_participant_id, body, sent_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [orgId, input.conversationId, input.senderParticipantId, input.body, input.sentAt],
  );
  return {
    id: String(res.rows[0].id),
    conversationId: input.conversationId,
    senderParticipantId: input.senderParticipantId,
    body: input.body,
    sentAt: input.sentAt,
  };
}

/** Managed history, oldest first (stable insertion order, same as legacy). */
export async function listManagedMessages(
  orgId: string,
  conversationId: string,
  limit = HISTORY_LIMIT,
): Promise<ManagedMessage[]> {
  const res = await requirePool().query<{
    id: string;
    sender_participant_id: string;
    body: string;
    sent_at: string;
  }>(
    `SELECT id, sender_participant_id, body, sent_at
     FROM conv_messages
     WHERE org_id = $1 AND conversation_id = $2
     ORDER BY inserted_at ASC
     LIMIT $3`,
    [orgId, conversationId, Math.min(limit, HISTORY_LIMIT)],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    conversationId,
    senderParticipantId: r.sender_participant_id,
    body: r.body,
    sentAt: Number(r.sent_at),
  }));
}

export async function insertE2eMessage(
  orgId: string,
  input: {
    conversationId: string;
    recipientPublicKey: string;
    senderPublicKey: string;
    senderDisplayName: string;
    ciphertext: string;
    nonce: string;
    sentAt: number;
  },
): Promise<void> {
  await requirePool().query(
    `INSERT INTO conv_messages_e2e
       (org_id, conversation_id, recipient_public_key, sender_public_key, sender_display_name, ciphertext, nonce, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orgId,
      input.conversationId,
      input.recipientPublicKey,
      input.senderPublicKey,
      input.senderDisplayName,
      input.ciphertext,
      input.nonce,
      input.sentAt,
    ],
  );
}

/** E2E history addressed to one recipient key, oldest first. */
export async function listE2eMessages(
  orgId: string,
  conversationId: string,
  recipientPublicKey: string,
): Promise<HistoryEntry[]> {
  const res = await requirePool().query<{
    sender_public_key: string;
    sender_display_name: string;
    ciphertext: string;
    nonce: string;
    sent_at: string;
  }>(
    `SELECT sender_public_key, sender_display_name, ciphertext, nonce, sent_at
     FROM conv_messages_e2e
     WHERE org_id = $1 AND conversation_id = $2 AND recipient_public_key = $3
     ORDER BY inserted_at ASC
     LIMIT $4`,
    [orgId, conversationId, recipientPublicKey, HISTORY_LIMIT],
  );
  return res.rows.map((r) => ({
    fromPublicKey: r.sender_public_key,
    fromDisplayName: r.sender_display_name,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
    sentAt: Number(r.sent_at),
  }));
}
