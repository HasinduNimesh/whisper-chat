// @vitest-environment node
// Crypto is pure (no DOM). Run in Node so libsodium's typed arrays aren't
// confused by jsdom's separate-realm Uint8Array (which breaks instanceof checks).
import { describe, it, expect, beforeAll } from 'vitest';
import {
  initCrypto,
  generateIdentity,
  sealTo,
  openFrom,
  safetyNumber,
} from './index';

beforeAll(async () => {
  await initCrypto();
});

describe('E2E message sealing', () => {
  it('round-trips a message between two identities', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();

    const sealed = sealTo('hello bob', bob.publicKey, alice.privateKey);
    const opened = openFrom(sealed, alice.publicKey, bob.privateKey);

    expect(opened).toBe('hello bob');
  });

  it('produces different ciphertext each time (fresh nonce)', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const a = sealTo('same text', bob.publicKey, alice.privateKey);
    const b = sealTo('same text', bob.publicKey, alice.privateKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('rejects a tampered ciphertext', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealTo('secret', bob.publicKey, alice.privateKey);

    // Flip a character in the ciphertext.
    const tampered = {
      ...sealed,
      ciphertext: sealed.ciphertext.slice(0, -2) + (sealed.ciphertext.endsWith('A') ? 'B' : 'A'),
    };
    expect(() => openFrom(tampered, alice.publicKey, bob.privateKey)).toThrow();
  });

  it('rejects decryption by the wrong recipient', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eve = generateIdentity();
    const sealed = sealTo('not for eve', bob.publicKey, alice.privateKey);
    expect(() => openFrom(sealed, alice.publicKey, eve.privateKey)).toThrow();
  });
});

describe('safety number', () => {
  it('is identical regardless of argument order', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    expect(safetyNumber(alice.publicKey, bob.publicKey)).toBe(
      safetyNumber(bob.publicKey, alice.publicKey),
    );
  });

  it('differs for different peers', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eve = generateIdentity();
    expect(safetyNumber(alice.publicKey, bob.publicKey)).not.toBe(
      safetyNumber(alice.publicKey, eve.publicKey),
    );
  });
});
