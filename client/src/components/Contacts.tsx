import { useEffect, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { fromB64, personalRoomId, encodeContactCode, decodeContactCode } from '../crypto';
import { loadContacts, addContact, removeContact, type Contact } from '../crypto/contacts';
import { Avatar } from './Avatar';
import { Modal, PrimaryButton, SecondaryButton, ErrorText, inputClass } from './ModalKit';

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

function AddContactModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    try {
      const contact = decodeContactCode(code.trim());
      addContact(contact.publicKey, contact.displayName);
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid contact code');
    }
  }

  return (
    <Modal title="Add contact" onClose={onClose}>
      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        rows={4}
        placeholder="Paste their contact code"
        className={`${inputClass} resize-none font-mono text-[11px] leading-relaxed`}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <PrimaryButton onClick={submit} disabled={!code.trim()}>
        Add
      </PrimaryButton>
    </Modal>
  );
}

function ShareCodeModal({ displayName, onClose }: { displayName: string; onClose: () => void }) {
  const ensureIdentity = useChatStore((s) => s.ensureIdentity);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
      <SecondaryButton onClick={onClose}>Done</SecondaryButton>
    </Modal>
  );
}
