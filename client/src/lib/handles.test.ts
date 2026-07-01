import { describe, it, expect } from 'vitest';
import { isValidHandle } from './handles';

describe('isValidHandle', () => {
  it('accepts lowercase letters, numbers, and underscores within length bounds', () => {
    expect(isValidHandle('alice_2')).toBe(true);
    expect(isValidHandle('abc')).toBe(true);
    expect(isValidHandle('a'.repeat(20))).toBe(true);
  });

  it('rejects handles that are too short', () => {
    expect(isValidHandle('ab')).toBe(false);
  });

  it('rejects handles that are too long', () => {
    expect(isValidHandle('a'.repeat(21))).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isValidHandle('Alice')).toBe(false);
  });

  it('rejects symbols and spaces', () => {
    expect(isValidHandle('alice!')).toBe(false);
    expect(isValidHandle('alice smith')).toBe(false);
    expect(isValidHandle('@alice')).toBe(false);
  });
});
