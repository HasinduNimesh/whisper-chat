/**
 * Anonymous B2C visitor identity: the widget holds a random secret in the
 * iframe's storage; we store only its SHA-256, scoped per org. Presenting
 * the secret is what "being" that visitor means — treat it like a session
 * token that never expires (visitors have no credentials to re-derive one).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createVisitor, getVisitorBySecretHash, type Visitor } from '../db/index.js';

const MAX_SECRET_LENGTH = 256;

export function hashVisitorSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Create a brand-new visitor; returns the raw secret exactly once. */
export async function mintVisitor(
  orgId: string,
  displayName: string,
): Promise<{ visitor: Visitor; secret: string }> {
  const secret = randomBytes(32).toString('base64url');
  const visitor = await createVisitor(orgId, hashVisitorSecret(secret), displayName);
  return { visitor, secret };
}

/** Resolve a presented secret to its visitor, or null. */
export async function resolveVisitor(orgId: string, secret: unknown): Promise<Visitor | null> {
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
    return null;
  }
  return getVisitorBySecretHash(orgId, hashVisitorSecret(secret));
}
