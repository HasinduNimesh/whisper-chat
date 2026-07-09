/**
 * Conversations and their participants. A conversation is the org-scoped
 * unit of chat: B2C (visitor ↔ org agents) or C2C (two store users about a
 * listing). Its `encryption` is snapshotted from the org at creation and
 * never changes. Every query is scoped by org_id.
 */
import { requirePool } from './pool.js';
import type { EncryptionMode } from './orgs.js';

export type ConversationKind = 'b2c' | 'c2c';
export type ConversationStatus = 'open' | 'closed';
export type ParticipantKind = 'agent' | 'visitor' | 'external';

export interface Conversation {
  id: string;
  orgId: string;
  kind: ConversationKind;
  encryption: EncryptionMode;
  externalKey: string | null;
  context: Record<string, unknown> | null;
  status: ConversationStatus;
  assignedAgentId: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
}

export interface Participant {
  id: string;
  conversationId: string;
  kind: ParticipantKind;
  agentId: string | null;
  visitorId: string | null;
  externalId: string | null;
  displayName: string;
  publicKey: string | null;
}

interface ConversationRow {
  id: string;
  org_id: string;
  kind: ConversationKind;
  encryption: EncryptionMode;
  external_key: string | null;
  context: Record<string, unknown> | null;
  status: ConversationStatus;
  assigned_agent_id: string | null;
  created_at: Date;
  last_message_at: Date | null;
}

interface ParticipantRow {
  id: string;
  conversation_id: string;
  kind: ParticipantKind;
  agent_id: string | null;
  visitor_id: string | null;
  external_id: string | null;
  display_name: string;
  public_key: string | null;
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    encryption: r.encryption,
    externalKey: r.external_key,
    context: r.context,
    status: r.status,
    assignedAgentId: r.assigned_agent_id,
    createdAt: r.created_at,
    lastMessageAt: r.last_message_at,
  };
}

function toParticipant(r: ParticipantRow): Participant {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.kind,
    agentId: r.agent_id,
    visitorId: r.visitor_id,
    externalId: r.external_id,
    displayName: r.display_name,
    publicKey: r.public_key,
  };
}

const CONV_COLUMNS =
  'id, org_id, kind, encryption, external_key, context, status, assigned_agent_id, created_at, last_message_at';
const PART_COLUMNS =
  'id, conversation_id, kind, agent_id, visitor_id, external_id, display_name, public_key';

export async function createConversation(
  orgId: string,
  input: {
    kind: ConversationKind;
    encryption: EncryptionMode;
    externalKey?: string;
    context?: Record<string, unknown>;
  },
): Promise<Conversation> {
  const res = await requirePool().query<ConversationRow>(
    `INSERT INTO conversations (org_id, kind, encryption, external_key, context)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${CONV_COLUMNS}`,
    [orgId, input.kind, input.encryption, input.externalKey ?? null, input.context ?? null],
  );
  return toConversation(res.rows[0]);
}

export async function getConversation(
  orgId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const res = await requirePool().query<ConversationRow>(
    `SELECT ${CONV_COLUMNS} FROM conversations WHERE org_id = $1 AND id = $2`,
    [orgId, conversationId],
  );
  return res.rows[0] ? toConversation(res.rows[0]) : null;
}

/** Find by the store-side conversation identity (C2C / identified B2C upsert path). */
export async function getConversationByExternalKey(
  orgId: string,
  externalKey: string,
): Promise<Conversation | null> {
  const res = await requirePool().query<ConversationRow>(
    `SELECT ${CONV_COLUMNS} FROM conversations WHERE org_id = $1 AND external_key = $2`,
    [orgId, externalKey],
  );
  return res.rows[0] ? toConversation(res.rows[0]) : null;
}

/** An anonymous visitor's open conversation with the org, if any. */
export async function getOpenConversationForVisitor(
  orgId: string,
  visitorId: string,
): Promise<Conversation | null> {
  const res = await requirePool().query<ConversationRow>(
    `SELECT ${CONV_COLUMNS.split(', ')
      .map((c) => `c.${c}`)
      .join(', ')}
     FROM conversations c
     JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE c.org_id = $1 AND c.status = 'open' AND p.visitor_id = $2
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [orgId, visitorId],
  );
  return res.rows[0] ? toConversation(res.rows[0]) : null;
}

export interface InboxFilter {
  status?: ConversationStatus;
  assignedAgentId?: string;
  unassigned?: boolean;
  limit?: number;
}

/** Inbox listing, newest activity first. */
export async function listConversations(
  orgId: string,
  filter: InboxFilter = {},
): Promise<Conversation[]> {
  const where: string[] = ['org_id = $1'];
  const params: unknown[] = [orgId];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.unassigned) {
    where.push('assigned_agent_id IS NULL');
  } else if (filter.assignedAgentId) {
    params.push(filter.assignedAgentId);
    where.push(`assigned_agent_id = $${params.length}`);
  }
  params.push(Math.min(filter.limit ?? 100, 200));
  const res = await requirePool().query<ConversationRow>(
    `SELECT ${CONV_COLUMNS} FROM conversations
     WHERE ${where.join(' AND ')}
     ORDER BY last_message_at DESC NULLS LAST, created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(toConversation);
}

/** Assign (or unassign with null). Returns false when not in this org. */
export async function assignConversation(
  orgId: string,
  conversationId: string,
  agentId: string | null,
): Promise<boolean> {
  const res = await requirePool().query(
    'UPDATE conversations SET assigned_agent_id = $3 WHERE org_id = $1 AND id = $2',
    [orgId, conversationId, agentId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setConversationStatus(
  orgId: string,
  conversationId: string,
  status: ConversationStatus,
): Promise<boolean> {
  const res = await requirePool().query(
    'UPDATE conversations SET status = $3 WHERE org_id = $1 AND id = $2',
    [orgId, conversationId, status],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function touchConversation(orgId: string, conversationId: string): Promise<void> {
  await requirePool().query(
    'UPDATE conversations SET last_message_at = now() WHERE org_id = $1 AND id = $2',
    [orgId, conversationId],
  );
}

// ── Participants ─────────────────────────────────────────────────────────────

/**
 * Idempotently add a participant: the partial unique indexes on
 * (conversation_id, agent_id/visitor_id/external_id) make re-joins converge
 * on the existing row (display name/public key refresh on conflict).
 */
export async function addParticipant(
  orgId: string,
  conversationId: string,
  input: {
    kind: ParticipantKind;
    agentId?: string;
    visitorId?: string;
    externalId?: string;
    displayName: string;
    publicKey?: string;
  },
): Promise<Participant> {
  const conflictTarget =
    input.kind === 'agent'
      ? '(conversation_id, agent_id) WHERE agent_id IS NOT NULL'
      : input.kind === 'visitor'
        ? '(conversation_id, visitor_id) WHERE visitor_id IS NOT NULL'
        : '(conversation_id, external_id) WHERE external_id IS NOT NULL';
  const res = await requirePool().query<ParticipantRow>(
    `INSERT INTO conversation_participants
       (org_id, conversation_id, kind, agent_id, visitor_id, external_id, display_name, public_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT ${conflictTarget}
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   public_key = COALESCE(EXCLUDED.public_key, conversation_participants.public_key)
     RETURNING ${PART_COLUMNS}`,
    [
      orgId,
      conversationId,
      input.kind,
      input.agentId ?? null,
      input.visitorId ?? null,
      input.externalId ?? null,
      input.displayName,
      input.publicKey ?? null,
    ],
  );
  return toParticipant(res.rows[0]);
}

export async function listParticipants(
  orgId: string,
  conversationId: string,
): Promise<Participant[]> {
  const res = await requirePool().query<ParticipantRow>(
    `SELECT ${PART_COLUMNS} FROM conversation_participants
     WHERE org_id = $1 AND conversation_id = $2
     ORDER BY created_at ASC`,
    [orgId, conversationId],
  );
  return res.rows.map(toParticipant);
}

/** Participants for many conversations in one query (inbox rendering). */
export async function listParticipantsForConversations(
  orgId: string,
  conversationIds: string[],
): Promise<Map<string, Participant[]>> {
  const byConv = new Map<string, Participant[]>();
  if (conversationIds.length === 0) return byConv;
  const res = await requirePool().query<ParticipantRow>(
    `SELECT ${PART_COLUMNS} FROM conversation_participants
     WHERE org_id = $1 AND conversation_id = ANY($2::uuid[])
     ORDER BY created_at ASC`,
    [orgId, conversationIds],
  );
  for (const row of res.rows) {
    const list = byConv.get(row.conversation_id) ?? [];
    list.push(toParticipant(row));
    byConv.set(row.conversation_id, list);
  }
  return byConv;
}

export async function getParticipant(
  orgId: string,
  conversationId: string,
  participantId: string,
): Promise<Participant | null> {
  const res = await requirePool().query<ParticipantRow>(
    `SELECT ${PART_COLUMNS} FROM conversation_participants
     WHERE org_id = $1 AND conversation_id = $2 AND id = $3`,
    [orgId, conversationId, participantId],
  );
  return res.rows[0] ? toParticipant(res.rows[0]) : null;
}
