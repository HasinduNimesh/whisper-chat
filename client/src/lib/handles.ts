/**
 * Optional @handle directory — a friendlier way to find someone than pasting
 * their full contact code. Requires the server to have DATABASE_URL set (see
 * server/src/db.ts); there's no client-side fallback since the whole point
 * is a standing, server-side lookup.
 *
 * IMPORTANT: a resolved handle is only a candidate public key, not a trust
 * upgrade — always verify the safety number (see crypto/trust.ts, Roster.tsx)
 * before trusting who you're talking to, exactly as with any other contact.
 */
import { backendOrigin } from '../signaling/client';

const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

export class HandlesUnavailableError extends Error {
  constructor() {
    super("Handles aren't set up on this server");
  }
}

async function parseJsonError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Claim `handle` for your identity. Throws on invalid input, taken handle, or an unconfigured server. */
export async function claimHandle(handle: string, publicKey: string, displayName: string): Promise<void> {
  const res = await fetch(`${backendOrigin()}/handles/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, publicKey, displayName }),
  });
  if (res.status === 503) throw new HandlesUnavailableError();
  if (!res.ok) throw new Error(await parseJsonError(res));
}

/** Look up a handle. Returns null if not found; throws only for an unconfigured server or network error. */
export async function lookupHandle(
  handle: string,
): Promise<{ publicKey: string; displayName: string } | null> {
  const res = await fetch(`${backendOrigin()}/handles/${encodeURIComponent(handle)}`);
  if (res.status === 503) throw new HandlesUnavailableError();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await parseJsonError(res));
  return (await res.json()) as { publicKey: string; displayName: string };
}
