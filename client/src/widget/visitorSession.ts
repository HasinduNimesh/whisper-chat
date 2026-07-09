/**
 * Anonymous visitor identity, persisted in the IFRAME's origin storage —
 * the embedding store page can never read it, and modern browsers partition
 * third-party iframe storage per embedding site, which conveniently scopes
 * a visitor identity per store.
 */
import { backendOrigin } from '../signaling/client';

const keyFor = (orgSlug: string) => `whisper.widget.visitor.v1.${orgSlug}`;

export interface WidgetSession {
  visitorSecret: string;
  orgName: string;
  encryptionMode: 'e2e' | 'managed';
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${backendOrigin()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`);
  }
  return data as T;
}

/** Ensure a valid visitor session, reusing (and revalidating) a stored secret. */
export async function ensureVisitorSession(orgSlug: string): Promise<WidgetSession> {
  const stored = localStorage.getItem(keyFor(orgSlug)) ?? undefined;
  const out = await post<{
    visitorSecret?: string;
    orgName: string;
    encryptionMode: 'e2e' | 'managed';
  }>('/api/widget/session', { orgSlug, visitorSecret: stored });
  // The server mints a new secret only when ours was missing or stale.
  const visitorSecret = out.visitorSecret ?? stored;
  if (!visitorSecret) throw new Error('No visitor session');
  localStorage.setItem(keyFor(orgSlug), visitorSecret);
  return { visitorSecret, orgName: out.orgName, encryptionMode: out.encryptionMode };
}

export interface WidgetConversation {
  conversationId: string;
  selfParticipantId: string;
  encryption: 'e2e' | 'managed';
  status: 'open' | 'closed';
}

/** Create/find the conversation, as visitor (secret) or via a signed token. */
export async function ensureConversation(input: {
  orgSlug: string;
  visitorSecret?: string;
  token?: string;
  publicKey?: string;
}): Promise<WidgetConversation> {
  const out = await post<{
    conversation: { id: string; encryption: 'e2e' | 'managed'; status: 'open' | 'closed' };
    selfParticipantId: string;
  }>('/api/widget/conversations', input);
  return {
    conversationId: out.conversation.id,
    selfParticipantId: out.selfParticipantId,
    encryption: out.conversation.encryption,
    status: out.conversation.status,
  };
}
