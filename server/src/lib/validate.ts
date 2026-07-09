/** Boundary validation helpers shared by the WS and HTTP surfaces. */

/** Validate that a base64 string decodes to a 32-byte X25519 public key. */
export function isValidPublicKey(b64: string): boolean {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > 128) return false;
  try {
    const buf = Buffer.from(b64, 'base64');
    // Reject non-canonical base64 (Buffer is lenient) by round-tripping.
    return buf.length === 32 && buf.toString('base64') === b64;
  } catch {
    return false;
  }
}

const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
export function isValidHandle(h: unknown): h is string {
  return typeof h === 'string' && HANDLE_PATTERN.test(h);
}

/** Org slugs: 3-40 chars, lowercase alphanumeric with inner hyphens. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
export function isValidSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_PATTERN.test(s) && !s.includes('--');
}

/**
 * Pragmatic email shape check (real validation is the invite/login loop
 * itself). Bounded to keep index/bcrypt inputs sane.
 */
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{3,255}$/;
export function isValidEmail(e: unknown): e is string {
  return typeof e === 'string' && e.length <= 320 && EMAIL_PATTERN.test(e);
}

/** Password bounds: minimum for strength, maximum to bound argon2 work. */
export function isValidPassword(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 8 && p.length <= 512;
}

/** Display names: trimmed, 1-64 chars, with a fallback. */
export function normalizeDisplayName(name: unknown, fallback = 'Anonymous'): string {
  return String(name ?? '').trim().slice(0, 64) || fallback;
}
