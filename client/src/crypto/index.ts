/**
 * Client-side cryptography. Everything here runs in the browser; secret keys
 * never leave the device. Messages are sealed with authenticated public-key
 * encryption (libsodium crypto_box = X25519 + XSalsa20-Poly1305) so each
 * recipient gets a ciphertext only they can open, with sender authenticity.
 */
import _sodium from 'libsodium-wrappers';

export type Sodium = typeof _sodium;

let sodium: Sodium | null = null;

/** Must be awaited once before any other crypto call. */
export async function initCrypto(): Promise<Sodium> {
  if (sodium) return sodium;
  await _sodium.ready;
  sodium = _sodium;
  return sodium;
}

function s(): Sodium {
  if (!sodium) throw new Error('Crypto not initialised — call initCrypto() first');
  return sodium;
}

export interface Identity {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SealedMessage {
  ciphertext: string; // base64
  nonce: string; // base64
}

const STORAGE_KEY = 'whisper.identity.v1';

/** Generate a fresh X25519 identity keypair. */
export function generateIdentity(): Identity {
  const kp = s().crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/**
 * Load the persisted identity, or create and persist a new one.
 * NOTE: v1 stores the private key in localStorage for simplicity. M5 hardens
 * this to a non-extractable IndexedDB store.
 */
export function loadOrCreateIdentity(): Identity {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { publicKey: string; privateKey: string };
      return {
        publicKey: fromB64(parsed.publicKey),
        privateKey: fromB64(parsed.privateKey),
      };
    } catch {
      // fall through and regenerate
    }
  }
  const id = generateIdentity();
  saveIdentity(id);
  return id;
}

/** Persist an identity as the active one for this browser (overwrites any existing). */
export function saveIdentity(identity: Identity): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ publicKey: toB64(identity.publicKey), privateKey: toB64(identity.privateKey) }),
  );
}

/** Encrypt a UTF-8 string to a recipient. Returns base64 ciphertext + nonce. */
export function sealTo(
  plaintext: string,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): SealedMessage {
  const lib = s();
  const nonce = lib.randombytes_buf(lib.crypto_box_NONCEBYTES);
  const message = lib.from_string(plaintext);
  const ciphertext = lib.crypto_box_easy(message, nonce, recipientPublicKey, senderPrivateKey);
  return { ciphertext: toB64(ciphertext), nonce: toB64(nonce) };
}

/** Decrypt a sealed message from a known sender. Throws on tamper/auth failure. */
export function openFrom(
  sealed: SealedMessage,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): string {
  const lib = s();
  const plain = lib.crypto_box_open_easy(
    fromB64(sealed.ciphertext),
    fromB64(sealed.nonce),
    senderPublicKey,
    recipientPrivateKey,
  );
  return lib.to_string(plain);
}

/**
 * Deterministic, human-comparable safety number for two identities. If both
 * peers see the same number, there is no man-in-the-middle on the key exchange.
 */
export function safetyNumber(pubA: Uint8Array, pubB: Uint8Array): string {
  const lib = s();
  // Order-independent: hash the sorted concatenation so both sides agree.
  const [first, second] = [toB64(pubA), toB64(pubB)].sort();
  const digest = lib.crypto_generichash(32, lib.from_string(first + second));
  // Render as 12 groups of 5 digits, Signal-style.
  let out = '';
  for (let i = 0; i < 30; i++) {
    out += (digest[i % digest.length] % 10).toString();
    if ((i + 1) % 5 === 0 && i !== 29) out += ' ';
  }
  return out;
}

/* ---- base64 helpers (standard alphabet, padded — libsodium ORIGINAL) ---- */

export function toB64(bytes: Uint8Array): string {
  return s().to_base64(bytes, s().base64_variants.ORIGINAL);
}

export function fromB64(text: string): Uint8Array {
  return s().from_base64(text, s().base64_variants.ORIGINAL);
}

/* ------------------------------------------------------------------ */
/* Identity export/import — carry one identity to a second device,     */
/* so history sealed to that public key is readable there too.         */
/* ------------------------------------------------------------------ */

const IDENTITY_EXPORT_PREFIX = 'whisper-id-v1:';

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function packUint32(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

function unpackUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

// libsodium-wrappers (the lightweight build used here, not -sumo) doesn't
// include crypto_pwhash/Argon2 at all. Use the browser's native Web Crypto
// PBKDF2 for the passphrase-derived key instead — no extra dependency, and
// well past current (2023 OWASP) minimums for PBKDF2-HMAC-SHA256 — then hand
// that key to libsodium's crypto_secretbox for the actual encryption.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;

async function deriveKeyPBKDF2(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt the whole identity (public + private key) with a passphrase, for
 * copying to a second device. This is a rare, high-value operation
 * (compromise = full identity theft), so it's worth spending real time
 * making offline brute-force expensive — hence the high PBKDF2 iteration
 * count. The iteration count actually used is embedded in the envelope so a
 * future tuning change can't break an export sitting in someone's password
 * manager for months.
 */
export async function exportIdentity(identity: Identity, passphrase: string): Promise<string> {
  const lib = s();
  const salt = lib.randombytes_buf(PBKDF2_SALT_BYTES);
  const key = await deriveKeyPBKDF2(passphrase, salt, PBKDF2_ITERATIONS);
  // Encrypt the full identity (not just the private key) so a successful
  // import can immediately re-derive and display the safety number — a
  // concrete way for the user to confirm they got their own identity back.
  const plaintext = lib.from_string(
    JSON.stringify({ publicKey: toB64(identity.publicKey), privateKey: toB64(identity.privateKey) }),
  );
  const nonce = lib.randombytes_buf(lib.crypto_secretbox_NONCEBYTES);
  const ciphertext = lib.crypto_secretbox_easy(plaintext, nonce, key);
  lib.memzero(key);
  lib.memzero(plaintext);

  const blob = concatBytes([salt, packUint32(PBKDF2_ITERATIONS), nonce, ciphertext]);
  return IDENTITY_EXPORT_PREFIX + toB64(blob);
}

/** Reverse of exportIdentity. Throws if the blob is malformed or the passphrase is wrong. */
export async function importIdentity(blob: string, passphrase: string): Promise<Identity> {
  if (!blob.startsWith(IDENTITY_EXPORT_PREFIX)) {
    throw new Error('Not a valid Whisper identity export');
  }
  const lib = s();
  const raw = fromB64(blob.slice(IDENTITY_EXPORT_PREFIX.length));
  const nonceLen = lib.crypto_secretbox_NONCEBYTES;

  let offset = 0;
  const salt = raw.slice(offset, offset + PBKDF2_SALT_BYTES);
  offset += PBKDF2_SALT_BYTES;
  const iterations = unpackUint32(raw, offset);
  offset += 4;
  const nonce = raw.slice(offset, offset + nonceLen);
  offset += nonceLen;
  const ciphertext = raw.slice(offset);

  const key = await deriveKeyPBKDF2(passphrase, salt, iterations);
  let plain: Uint8Array;
  try {
    plain = lib.crypto_secretbox_open_easy(ciphertext, nonce, key);
  } catch {
    lib.memzero(key);
    throw new Error('Wrong passphrase, or a corrupted export code');
  }
  lib.memzero(key);
  const parsed = JSON.parse(lib.to_string(plain)) as { publicKey: string; privateKey: string };
  lib.memzero(plain);
  return { publicKey: fromB64(parsed.publicKey), privateKey: fromB64(parsed.privateKey) };
}
