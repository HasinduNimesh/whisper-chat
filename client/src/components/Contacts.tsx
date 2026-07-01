import { useEffect, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { fromB64, toB64, personalRoomId, encodeContactCode, decodeContactCode } from '../crypto';
import { loadContacts, addContact, removeContact, type Contact } from '../crypto/contacts';
import { isValidHandle, claimHandle, lookupHandle } from '../lib/handles';
import { Avatar } from './Avatar';
import { Modal, Warning, PrimaryButton, SecondaryButton, ErrorText, inputClass } from './ModalKit';

const MY_HANDLE_KEY = 'whisper.myHandle.v1'; // local cache/hint only — the server is authoritative

/**
 * Saved contacts you can message directly, without swapping a room code
 * each time. Purely client-side: a "personal chat" is just a 2-person room
 * whose id both sides compute independently from their public keys (see
 * personalRoomId in ../crypto), so no server changes were needed for this.
 */
export function ContactsPanel({ myDisplayName }: { myDisplayName: string }) {
  const identity = useChatStore((s) => s.identity);
  const ensureIdentity = useChatStore((s) => s.ensureIdentity);
  const join = useChatStore((s) => s.join);
  const status = useChatStore((s) => s.status);
  const [contacts, setContacts] = useState<Contact[]>(() => loadContacts());
  const [addOpen, setAddOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const connecting = status === 'connecting';

  function refresh() {
    setContacts(loadContacts());
  }

  async function startChat(contact: Contact) {
    if (connecting) return;
    const me = identity ?? (await ensureIdentity());
    const roomId = personalRoomId(me.publicKey, fromB64(contact.publicKey));
    void join(roomId, myDisplayName.trim() || 'Anonymous');
  }

  return (
    <div className="space-y-3">
      {contacts.length === 0 ? (
        <p className="py-2 text-center text-xs text-wa-secondary">
          No contacts yet. Add one below, or share your code so someone can add you.
        </p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto scrollbar-thin">
          {contacts.map((c) => (
            <li key={c.publicKey}>
              <button
                onClick={() => void startChat(c)}
                disabled={connecting}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-wa-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Avatar name={c.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-wa-primary">{c.displayName}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeContact(c.publicKey);
                    refresh();
                  }}
                  title="Remove contact"
                  aria-label={`Remove ${c.displayName}`}
                  className="shrink-0 rounded-full px-2 text-xs text-wa-secondary hover:text-red-400"
                >
                  ×
                </button>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-lg bg-wa-input py-2 text-xs font-medium text-wa-secondary transition hover:text-wa-primary"
        >
          Add contact
        </button>
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="rounded-lg bg-wa-input py-2 text-xs font-medium text-wa-secondary transition hover:text-wa-primary"
        >
          Share my code
        </button>
      </div>

      {addOpen && (
        <AddContactModal
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            refresh();
            setAddOpen(false);
          }}
        />
      )}
      {shareOpen && <ShareCodeModal displayName={myDisplayName} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

/** Strips an optional leading "@" so both "alice" and "@alice" work as input. */
function normalizeHandleInput(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function AddContactModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    const trimmed = input.trim();
    // A pasted contact code has a recognizable prefix; anything else is
    // treated as an @handle to look up.
    if (trimmed.startsWith('whisper-contact-v1:')) {
      try {
        const contact = decodeContactCode(trimmed);
        addContact(contact.publicKey, contact.displayName);
        onAdded();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid contact code');
      }
      return;
    }

    const handle = normalizeHandleInput(trimmed);
    if (!isValidHandle(handle)) {
      setError('Paste a contact code, or enter a handle (3-20 letters/numbers/underscores).');
      return;
    }
    setBusy(true);
    try {
      const result = await lookupHandle(handle);
      if (!result) {
        setError(`No one has claimed @${handle}.`);
        return;
      }
      addContact(result.publicKey, result.displayName);
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add contact" onClose={onClose}>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={4}
        placeholder="Paste their contact code, or type @handle"
        className={`${inputClass} resize-none font-mono text-[11px] leading-relaxed`}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <PrimaryButton onClick={() => void submit()} disabled={busy || !input.trim()}>
        {busy ? 'Looking up…' : 'Add'}
      </PrimaryButton>
    </Modal>
  );
}

function ShareCodeModal({ displayName, onClose }: { displayName: string; onClose: () => void }) {
  const ensureIdentity = useChatStore((s) => s.ensureIdentity);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [myHandle, setMyHandle] = useState(() => localStorage.getItem(MY_HANDLE_KEY) ?? '');
  const [handleInput, setHandleInput] = useState('');
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleBusy, setHandleBusy] = useState(false);
  const [handleSaved, setHandleSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ensureIdentity().then((identity) => {
      if (!cancelled) setCode(encodeContactCode(identity.publicKey, displayName.trim() || 'Anonymous'));
    });
    return () => {
      cancelled = true;
    };
  }, [ensureIdentity, displayName]);

  async function copy() {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
  }

  async function saveHandle() {
    setHandleError(null);
    setHandleSaved(false);
    const handle = normalizeHandleInput(handleInput);
    if (!isValidHandle(handle)) {
      setHandleError('3-20 lowercase letters, numbers, or underscores.');
      return;
    }
    setHandleBusy(true);
    try {
      const identity = await ensureIdentity();
      await claimHandle(handle, toB64(identity.publicKey), displayName.trim() || 'Anonymous');
      localStorage.setItem(MY_HANDLE_KEY, handle);
      setMyHandle(handle);
      setHandleInput('');
      setHandleSaved(true);
    } catch (err) {
      setHandleError(err instanceof Error ? err.message : 'Could not claim that handle');
    } finally {
      setHandleBusy(false);
    }
  }

  return (
    <Modal title="Your contact code" onClose={onClose}>
      <p className="text-xs text-wa-secondary">
        Share this with someone so they can add you as a contact. It only contains your public
        identity — nothing secret.
      </p>
      <textarea
        readOnly
        value={code ?? 'Generating…'}
        rows={4}
        onFocus={(e) => e.currentTarget.select()}
        className={`${inputClass} resize-none font-mono text-[11px] leading-relaxed`}
      />
      <PrimaryButton onClick={() => void copy()} disabled={!code}>
        {copied ? 'Copied ✓' : 'Copy to clipboard'}
      </PrimaryButton>

      <div className="mt-1 space-y-2 border-t border-wa-border pt-3">
        <p className="text-xs font-medium text-wa-primary">
          Handle{myHandle ? `: @${myHandle}` : ' (optional)'}
        </p>
        <p className="text-[11px] text-wa-secondary">
          A short, memorable way for someone to find you instead of pasting the code above.
        </p>
        <div className="flex gap-2">
          <input
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value.toLowerCase())}
            placeholder={myHandle || 'e.g. alice_2'}
            maxLength={20}
            className={inputClass}
          />
          <button
            onClick={() => void saveHandle()}
            disabled={handleBusy || !handleInput.trim()}
            className="shrink-0 rounded-lg bg-wa-input px-3 text-xs font-medium text-wa-secondary transition hover:text-wa-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {handleBusy ? 'Saving…' : myHandle ? 'Change' : 'Claim'}
          </button>
        </div>
        {handleError && <ErrorText>{handleError}</ErrorText>}
        {handleSaved && <p className="text-xs text-wa-green">Saved.</p>}
        <Warning>
          A handle only helps someone find your public key — it isn&apos;t proof of who you are.
          Always verify the safety number after adding a contact this way.
        </Warning>
      </div>

      <SecondaryButton onClick={onClose}>Done</SecondaryButton>
    </Modal>
  );
}
