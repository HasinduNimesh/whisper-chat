// @vitest-environment node
// isPolite is pure and DOM-free; the RTCPeerConnection machinery is not unit
// tested here (it needs a real browser / wrtc), but the glare tie-breaker is.
import { describe, it, expect } from 'vitest';
import { isPolite } from './mesh';

describe('perfect-negotiation politeness', () => {
  it('is exactly one-sided for any pair of peers', () => {
    const a = 'peer-aaaa';
    const b = 'peer-bbbb';
    // Each side computes its own politeness with (self, other) swapped.
    expect(isPolite(a, b)).not.toBe(isPolite(b, a));
  });

  it('agrees regardless of which id is larger', () => {
    expect(isPolite('aaa', 'zzz')).toBe(true);
    expect(isPolite('zzz', 'aaa')).toBe(false);
  });

  it('is deterministic across the whole mesh (transitive ordering)', () => {
    const ids = ['p1', 'p2', 'p3', 'p4'];
    for (const self of ids) {
      for (const other of ids) {
        if (self === other) continue;
        // Symmetry invariant must hold for every pair so no pair deadlocks.
        expect(isPolite(self, other)).toBe(!isPolite(other, self));
      }
    }
  });
});
