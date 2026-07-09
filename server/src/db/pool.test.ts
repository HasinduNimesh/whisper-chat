import { describe, expect, it } from 'vitest';
import { normalizeSslMode } from './pool.js';

describe('normalizeSslMode', () => {
  it('rewrites require/prefer/verify-ca to verify-full', () => {
    for (const mode of ['require', 'prefer', 'verify-ca']) {
      const out = normalizeSslMode(`postgres://u:p@db.example.com:5432/app?sslmode=${mode}`);
      expect(out).toContain('sslmode=verify-full');
    }
  });

  it('leaves verify-full and disable untouched', () => {
    for (const mode of ['verify-full', 'disable']) {
      const url = `postgres://u:p@db.example.com:5432/app?sslmode=${mode}`;
      expect(normalizeSslMode(url)).toContain(`sslmode=${mode}`);
    }
  });

  it('leaves URLs without sslmode untouched', () => {
    const url = 'postgres://u:p@db.example.com:5432/app';
    expect(normalizeSslMode(url)).toBe(new URL(url).toString());
  });

  it('passes malformed URLs through for pg to report', () => {
    expect(normalizeSslMode('not a url')).toBe('not a url');
  });
});
