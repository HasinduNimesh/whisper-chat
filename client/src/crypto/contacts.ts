/**
 * Local "contacts" list: people you've added so you can jump straight into a
 * personal chat with them (see personalRoomId() in ./index.ts) without
 * swapping a room code every time. Purely a client-side convenience layer —
 * the server has no concept of contacts, only rooms.
 *
 * All state is local to the device (localStorage); none of it is sent
 * anywhere.
 */

const CONTACTS_KEY = 'whisper.contacts.v1'; // publicKey (b64) -> Contact

export interface Contact {
  publicKey: string; // base64
  displayName: string;
  addedAt: number;
}

type Store = Record<string, Contact>;

function load(): Store {
  try {
    const raw = localStorage.getItem(CONTACTS_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(store));
  } catch {
    /* storage full / unavailable — contacts are best-effort */
  }
}

/** All saved contacts, most recently added first. */
export function loadContacts(): Contact[] {
  return Object.values(load()).sort((a, b) => b.addedAt - a.addedAt);
}

/** Add (or update the display name of) a contact. */
export function addContact(publicKey: string, displayName: string): void {
  const store = load();
  store[publicKey] = { publicKey, displayName, addedAt: store[publicKey]?.addedAt ?? Date.now() };
  save(store);
}

export function removeContact(publicKey: string): void {
  const store = load();
  delete store[publicKey];
  save(store);
}
