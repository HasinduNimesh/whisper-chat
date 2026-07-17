import { describe, it, expect, beforeEach } from 'vitest';
import { buildShareLink, consumeShareLinkRoom } from './shareLink';

describe('buildShareLink', () => {
  it('puts the room code in the URL fragment, not the query string', () => {
    const link = buildShareLink('garden-42');
    const url = new URL(link);
    expect(url.search).toBe('');
    expect(url.hash).toBe('#room=garden-42');
  });

  it('percent-encodes special characters in the room id', () => {
    const link = buildShareLink('a b&c');
    const url = new URL(link);
    expect(url.hash).toBe('#room=a%20b%26c');
  });
});

describe('consumeShareLinkRoom', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('returns null when there is no room fragment', () => {
    window.history.replaceState(null, '', '/#other=1');
    expect(consumeShareLinkRoom()).toBeNull();
  });

  it('extracts the room id and strips the fragment from the URL', () => {
    window.history.replaceState(null, '', '/#room=garden-42');
    expect(consumeShareLinkRoom()).toBe('garden-42');
    expect(window.location.hash).toBe('');
  });

  it('round-trips a room id built by buildShareLink', () => {
    const link = buildShareLink('a b&c');
    const url = new URL(link);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    expect(consumeShareLinkRoom()).toBe('a b&c');
  });

  it('is not fooled by a room id crafted to look like it has already been consumed', () => {
    window.history.replaceState(null, '', '/#room=');
    expect(consumeShareLinkRoom()).toBeNull();
    expect(window.location.hash).toBe('');
  });
});
