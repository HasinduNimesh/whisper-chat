/**
 * Verification of store/marketplace-issued identity tokens.
 *
 * A store's backend signs a short-lived HS256 JWT with one of the org's API
 * keys (see docs/integrations.md). The token asserts WHO the end user is and
 * WHICH conversation they may join — the org's secret never leaves the
 * store's server, and the widget just ferries the opaque token to us.
 *
 * Verification is deliberately strict: pinned algorithm, known `kid`,
 * unrevoked key, mandatory subject/conversation claims, and a hard cap on
 * token lifetime (these are bearer credentials passing through a browser).
 */
import { decodeProtectedHeader, jwtVerify, errors as joseErrors } from 'jose';
import { getApiKeyForVerify } from '../db/index.js';

/** Bearer-token lifetime cap (seconds): exp may be at most this far ahead. */
const MAX_TOKEN_LIFETIME_S = 10 * 60;
const CLOCK_TOLERANCE_S = 60;
const MAX_TOKEN_LENGTH = 4096;
const MAX_CONTEXT_BYTES = 2048;

export class OrgTokenError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface VerifiedOrgToken {
  orgId: string;
  /** Store-side user id (`sub`). */
  externalId: string;
  displayName: string;
  kind: 'b2c' | 'c2c';
  /**
   * Store-side conversation key (`conv`). Both parties of a C2C thread must
   * be issued tokens with the *identical* string — it is the upsert key.
   */
  convKey: string;
  /** Optional listing/order context to show agents & participants. */
  context: Record<string, unknown> | null;
}

export async function verifyOrgToken(token: string): Promise<VerifiedOrgToken> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new OrgTokenError('Invalid token');
  }

  let kid: string | undefined;
  let alg: string | undefined;
  try {
    ({ kid, alg } = decodeProtectedHeader(token));
  } catch {
    throw new OrgTokenError('Malformed token');
  }
  if (alg !== 'HS256') throw new OrgTokenError('Unsupported token algorithm');
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 64) {
    throw new OrgTokenError('Missing key id');
  }

  const key = await getApiKeyForVerify(kid);
  if (!key) throw new OrgTokenError('Unknown key id');
  if (key.revokedAt) throw new OrgTokenError('Key revoked');

  let payload;
  try {
    ({ payload } = await jwtVerify(token, Buffer.from(key.secret, 'utf8'), {
      algorithms: ['HS256'], // pinned — never trust the header's choice
      clockTolerance: CLOCK_TOLERANCE_S,
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new OrgTokenError('Token expired');
    throw new OrgTokenError('Invalid token signature');
  }

  // Lifetime cap: a leaked token must age out quickly.
  const nowS = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number') throw new OrgTokenError('Token missing exp');
  if (payload.exp - nowS > MAX_TOKEN_LIFETIME_S + CLOCK_TOLERANCE_S) {
    throw new OrgTokenError(`Token lifetime exceeds ${MAX_TOKEN_LIFETIME_S / 60} minutes`);
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 128) {
    throw new OrgTokenError('Token missing sub (external user id)');
  }
  const convKey = payload.conv;
  if (typeof convKey !== 'string' || convKey.length === 0 || convKey.length > 256) {
    throw new OrgTokenError('Token missing conv (conversation key)');
  }
  const kind = payload.kind === 'c2c' ? 'c2c' : 'b2c';

  let context: Record<string, unknown> | null = null;
  if (payload.ctx !== undefined) {
    if (
      typeof payload.ctx !== 'object' ||
      payload.ctx === null ||
      Array.isArray(payload.ctx) ||
      JSON.stringify(payload.ctx).length > MAX_CONTEXT_BYTES
    ) {
      throw new OrgTokenError('Invalid ctx claim');
    }
    context = payload.ctx as Record<string, unknown>;
  }

  return {
    orgId: key.orgId,
    externalId: sub,
    displayName:
      typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 64)
        : 'Customer',
    kind,
    convKey,
    context,
  };
}
