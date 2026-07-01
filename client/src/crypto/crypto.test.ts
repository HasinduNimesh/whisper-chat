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
  exportIdentity,
  importIdentity,
  toB64,
  personalRoomId,
  encodeContactCode,
  decodeContactCode,
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

describe('identity export/import', () => {
  it('round-trips an identity with the correct passphrase', async () => {
    const alice = generateIdentity();
    const blob = await exportIdentity(alice, 'correct horse battery staple');
    const restored = await importIdentity(blob, 'correct horse battery staple');
    expect(toB64(restored.publicKey)).toBe(toB64(alice.publicKey));
    expect(toB64(restored.privateKey)).toBe(toB64(alice.privateKey));
    // Same identity => same safety number against a third party.
    const bob = generateIdentity();
    expect(safetyNumber(restored.publicKey, bob.publicKey)).toBe(
      safetyNumber(alice.publicKey, bob.publicKey),
    );
  }, 20_000);

  it('rejects the wrong passphrase', async () => {
    const alice = generateIdentity();
    const blob = await exportIdentity(alice, 'correct horse battery staple');
    await expect(importIdentity(blob, 'wrong passphrase')).rejects.toThrow();
  }, 20_000);

  it('rejects a malformed/foreign blob', async () => {
    await expect(importIdentity('not-a-real-export', 'whatever')).rejects.toThrow();
  });
});

describe('personal room id (contacts)', () => {
  it('is identical regardless of argument order', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    expect(personalRoomId(alice.publicKey, bob.publicKey)).toBe(
      personalRoomId(bob.publicKey, alice.publicKey),
    );
  });

  it('differs for different pairs', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eve = generateIdentity();
    expect(personalRoomId(alice.publicKey, bob.publicKey)).not.toBe(
      personalRoomId(alice.publicKey, eve.publicKey),
    );
  });

  it('is a short, room-id-safe string', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const id = personalRoomId(alice.publicKey, bob.publicKey);
    expect(id).toMatch(/^dm-[0-9a-f]{32}$/);
    expect(id.length).toBeLessThan(128);
  });
});

describe('contact codes', () => {
  it('round-trips a public identity', () => {
    const alice = generateIdentity();
    const code = encodeContactCode(alice.publicKey, 'Alice');
    const decoded = decodeContactCode(code);
    expect(decoded.displayName).toBe('Alice');
    expect(decoded.publicKey).toBe(toB64(alice.publicKey));
  });

  it('rejects a code with the wrong prefix', () => {
    expect(() => decodeContactCode('whisper-id-v1:notacontact')).toThrow();
  });

  it('rejects a corrupted code', () => {
    expect(() => decodeContactCode('whisper-contact-v1:not-valid-base64-json')).toThrow();
  });
});
