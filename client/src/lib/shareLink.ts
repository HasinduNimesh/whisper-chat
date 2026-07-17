/**
 * Shareable room links. The room code is the entire bearer secret for a
 * room, so it's carried as a URL *fragment* (`#room=...`), never a query
 * string: fragments are stripped by the browser before the request line is
 * sent, so they never reach server access logs, analytics, or `Referer`
 * headers — unlike `?room=...`, which would leak the code to every one of
 * those.
 */

const HASH_KEY = 'room';
const MAX_ROOM_ID_LENGTH = 128; // mirrors the server-side cap in ws.ts

/** Build a link that pre-fills (but does not auto-join) a room. */
export function buildShareLink(roomId: string): string {
  const url = new URL(window.location.href);
  url.hash = `${HASH_KEY}=${encodeURIComponent(roomId)}`;
  url.search = '';
  return url.toString();
}

/**
 * Read a room code left in the URL fragment by a share link, if any, and
 * immediately scrub it from the address bar + history via replaceState —
 * so it doesn't linger in browser history, shoulder-surf risk on screen
 * shares, or get re-copied by accident from the URL bar later. Returns
 * null if there's nothing there or it doesn't parse.
 */
export function consumeShareLinkRoom(): string | null {
  const hash = window.location.hash;
  if (!hash || !hash.startsWith(`#${HASH_KEY}=`)) return null;

  let roomId: string;
  try {
    roomId = decodeURIComponent(hash.slice(`#${HASH_KEY}=`.length));
  } catch {
    roomId = '';
  }
  roomId = roomId.trim().slice(0, MAX_ROOM_ID_LENGTH);

  // Strip the fragment regardless of whether parsing succeeded — a
  // malformed link shouldn't sit in the address bar either.
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(null, '', url.toString());

  return roomId || null;
}
