/**
 * Persistence for the original private-chat app: durable room membership,
 * per-recipient ciphertext history, and the @handle directory. Everything
 * here degrades gracefully without DATABASE_URL (no-ops / empty results),
 * except the handle directory which throws `HandlesUnavailableError` —
 * there's nothing sensible to degrade a standing global lookup to.
 *
 * The server only ever stores opaque ciphertext + routing metadata (room id,
 * sender/recipient public keys, display-name snapshots, timestamps) — never
 * plaintext. This is the same information a live relay already sees in
 * passing; persisting it just makes that metadata durable instead of
 * forgotten immediately, which is an explicit, accepted tradeoff for
 * cross-device + offline history.
 */
import type pg from 'pg';
import type { HistoryEntry, RoomMember } from '@private-chat/shared';
import { getPool, HandlesUnavailableError } from './pool.js';

const HISTORY_LIMIT = 200;

/** Record (or refresh) a room's durable membership — survives disconnects. */
export async function upsertRoomMember(
  roomId: string,
  publicKey: string,
  displayName: string,
): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO room_members (room_id, public_key, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (room_id, public_key)
     DO UPDATE SET display_name = EXCLUDED.display_name, last_seen_at = now()`,
    [roomId, publicKey, displayName],
  );
}

/** Every public key ever seen in this room, excluding one (the caller). */
export async function fetchRoomMembers(
  roomId: string,
  excludingPublicKey: string,
): Promise<Omit<RoomMember, 'online'>[]> {
  const p = getPool();
  if (!p) return [];
  const res = await p.query<{ public_key: string; display_name: string }>(
    `SELECT public_key, display_name FROM room_members WHERE room_id = $1 AND public_key != $2`,
    [roomId, excludingPublicKey],
  );
  return res.rows.map((r) => ({ publicKey: r.public_key, displayName: r.display_name }));
}

export interface PersistMessageInput {
  roomId: string;
  recipientPublicKey: string;
  senderPublicKey: string;
  senderDisplayName: string;
  ciphertext: string;
  nonce: string;
  sentAt: number;
}

/** Store a message for later retrieval. No-op if persistence isn't configured. */
export async function persistMessage(msg: PersistMessageInput): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO messages
       (room_id, recipient_public_key, sender_public_key, sender_display_name, ciphertext, nonce, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      msg.roomId,
      msg.recipientPublicKey,
      msg.senderPublicKey,
      msg.senderDisplayName,
      msg.ciphertext,
      msg.nonce,
      msg.sentAt,
    ],
  );
}

/**
 * Stored messages addressed to `recipientPublicKey`, oldest first. Ordered by
 * `inserted_at` (server-observed) rather than `sent_at`, even though both are
 * server timestamps here — `inserted_at` is the DB's own clock and always
 * consistent with insertion order, which is what matters for a stable replay.
 */
export async function fetchHistory(
  roomId: string,
  recipientPublicKey: string,
): Promise<HistoryEntry[]> {
  const p = getPool();
  if (!p) return [];
  const res = await p.query<{
    sender_public_key: string;
    sender_display_name: string;
    ciphertext: string;
    nonce: string;
    sent_at: string;
  }>(
    `SELECT sender_public_key, sender_display_name, ciphertext, nonce, sent_at
     FROM messages
     WHERE room_id = $1 AND recipient_public_key = $2
     ORDER BY inserted_at ASC
     LIMIT $3`,
    [roomId, recipientPublicKey, HISTORY_LIMIT],
  );
  return res.rows.map((r) => ({
    fromPublicKey: r.sender_public_key,
    fromDisplayName: r.sender_display_name,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
    sentAt: Number(r.sent_at),
  }));
}

function requireHandlesPool(): pg.Pool {
  const p = getPool();
  if (!p) throw new HandlesUnavailableError();
  return p;
}

/**
 * Claim `handle` for `publicKey`, releasing any handle that key previously
 * held. Returns false (never throws for this case) if the handle is already
 * taken by a different key — first writer wins on the race.
 */
export async function claimHandle(
  handle: string,
  publicKey: string,
  displayName: string,
): Promise<boolean> {
  const p = requireHandlesPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM handles WHERE public_key = $1', [publicKey]);
    const res = await client.query(
      `INSERT INTO handles (handle, public_key, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (handle) DO NOTHING`,
      [handle, publicKey, displayName],
    );
    await client.query('COMMIT');
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function lookupHandle(
  handle: string,
): Promise<{ publicKey: string; displayName: string } | null> {
  const p = requireHandlesPool();
  const res = await p.query<{ public_key: string; display_name: string }>(
    'SELECT public_key, display_name FROM handles WHERE handle = $1',
    [handle],
  );
  const row = res.rows[0];
  return row ? { publicKey: row.public_key, displayName: row.display_name } : null;
}
