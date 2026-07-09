import { describe, expect, it } from 'vitest';
import { dummyHash, hashPassword, verifyPassword } from './passwords.js';

describe('passwords (argon2id)', () => {
  it('round-trips and rejects wrong passwords', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'incorrect horse')).toBe(false);
  });

  it('hashes are salted (two hashes of the same input differ)', async () => {
    const [a, b] = await Promise.all([hashPassword('same input'), hashPassword('same input')]);
    expect(a).not.toBe(b);
  });

  it('never throws on malformed hashes — treats them as non-matches', async () => {
    expect(await verifyPassword('garbage', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('dummyHash is a stable argon2 hash usable for timing equalization', async () => {
    const d1 = await dummyHash();
    const d2 = await dummyHash();
    expect(d1).toBe(d2);
    expect(await verifyPassword(d1, 'any guess')).toBe(false);
  });
});
