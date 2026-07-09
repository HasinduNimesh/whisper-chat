/**
 * Per-agent E2E identity for dashboards of E2E-mode orgs. Same storage
 * caveat as the private chat app (localStorage, documented in SECURITY.md);
 * keyed per user id so shared machines don't cross identities.
 */
import { api } from './api';
import {
  fromB64,
  generateIdentity,
  initCrypto,
  toB64,
  type Identity,
} from '../crypto/index';

const keyFor = (userId: string) => `whisper.agent-identity.v1.${userId}`;

/**
 * Load (or create) this agent's keypair and make sure the server knows the
 * public key. Returns the identity, crypto initialized.
 */
export async function ensureAgentIdentity(
  userId: string,
  publishedKey: string | null,
): Promise<Identity> {
  await initCrypto();
  let identity: Identity | null = null;
  const raw = localStorage.getItem(keyFor(userId));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { publicKey: string; privateKey: string };
      identity = { publicKey: fromB64(parsed.publicKey), privateKey: fromB64(parsed.privateKey) };
    } catch {
      identity = null;
    }
  }
  if (!identity) {
    identity = generateIdentity();
    localStorage.setItem(
      keyFor(userId),
      JSON.stringify({ publicKey: toB64(identity.publicKey), privateKey: toB64(identity.privateKey) }),
    );
  }
  const publicB64 = toB64(identity.publicKey);
  if (publishedKey !== publicB64) {
    // First login on this browser (or a rotation): publish so peers can seal to us.
    await api('PATCH', '/api/auth/me/public-key', { publicKey: publicB64 });
  }
  return identity;
}
