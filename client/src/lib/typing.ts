import type { PeerIdentity } from '@private-chat/shared';

/** Display names of peers currently typing (only those still in the roster). */
export function typingNames(
  typingPeers: Record<string, boolean>,
  peers: Record<string, PeerIdentity>,
): string[] {
  return Object.keys(typingPeers)
    .filter((id) => typingPeers[id] && peers[id])
    .map((id) => peers[id].displayName);
}

/** WhatsApp-style "… is typing" label, or null when no one is typing. */
export function typingLabel(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}
