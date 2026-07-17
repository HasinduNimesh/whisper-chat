/**
 * Share-link flow: opening the app with a `#room=...` fragment (from
 * buildShareLink) should land on the join tab prefilled, and the fragment
 * must never survive in the address bar.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JoinRoom } from './JoinRoom';
import { buildShareLink } from '../lib/shareLink';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('JoinRoom share-link handoff', () => {
  it('prefills the join tab from a share link and strips the fragment', () => {
    const link = buildShareLink('garden-42');
    const url = new URL(link);
    window.history.replaceState(null, '', url.pathname + url.hash);

    render(<JoinRoom />);

    const input = screen.getByPlaceholderText('Paste the code you were sent') as HTMLInputElement;
    expect(input.value).toBe('garden-42');
    expect(window.location.hash).toBe('');
  });

  it('defaults to the start-new tab with no share-link fragment present', () => {
    render(<JoinRoom />);
    expect(screen.getByPlaceholderText('e.g. garden-42')).toBeInTheDocument();
  });
});
