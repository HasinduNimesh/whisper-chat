/**
 * Password hashing: argon2id with OWASP-recommended parameters (19 MiB
 * memory, t=2, p=1). The interface is deliberately tiny so a platform
 * without argon2 prebuilds could swap in another KDF behind it (see
 * CONTRIBUTING.md).
 */
import argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // KiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed/foreign hash — treat as non-match, never throw
  }
}

/**
 * A real hash of an unguessable value, verified against for *unknown* emails
 * so login latency doesn't reveal whether an account exists.
 */
let dummyHashPromise: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(`dummy-${Math.random()}-${Date.now()}`);
  }
  return dummyHashPromise;
}
