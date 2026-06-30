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
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ publicKey: toB64(id.publicKey), privateKey: toB64(id.privateKey) }),
  );
  return id;
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

/* ---- base64 helpers (URL-safe, no padding via libsodium) ---- */

export function toB64(bytes: Uint8Array): string {
  return s().to_base64(bytes, s().base64_variants.ORIGINAL);
}

export function fromB64(text: string): Uint8Array {
  return s().from_base64(text, s().base64_variants.ORIGINAL);
}
