/**
 * Fetch wrapper for the cookie-authenticated dashboard API. Every request
 * carries credentials and the X-Requested-With header the server's CSRF
 * guard demands; errors normalize to ApiError with the server's message.
 */
import { backendOrigin } from '../signaling/client';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${backendOrigin()}${path}`, {
      method,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'fetch',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `Request failed (${res.status})`);
  }
  return data as T;
}

export interface OrgDto {
  id: string;
  name: string;
  slug: string;
  encryptionMode: 'e2e' | 'managed';
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'agent';
  publicKey: string | null;
  disabled?: boolean;
  createdAt?: string;
}

export interface ParticipantDto {
  id: string;
  kind: 'agent' | 'visitor' | 'external';
  displayName: string;
  publicKey: string | null;
  agentId: string | null;
}

export interface ConversationDto {
  id: string;
  kind: 'b2c' | 'c2c';
  encryption: 'e2e' | 'managed';
  status: 'open' | 'closed';
  context: Record<string, unknown> | null;
  assignedAgentId: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  participants?: ParticipantDto[];
}

export interface ApiKeyDto {
  id: string;
  kid: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  /** Present only in the create response — shown exactly once. */
  secret?: string;
}
