import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useChatStore } from '../store/useChatStore';
import { ROOM_MIN_PEERS, ROOM_MAX_PEERS } from '@private-chat/shared';
import { Lock, Shield, Users, Refresh, Plus, ArrowLeft, Check, LinkIcon, Flame } from '../components/icons';
import { DocsLink } from '../components/DocsLink';
import { ImportIdentityModal } from '../components/IdentityBackup';
import { ContactsPanel } from '../components/Contacts';
import { buildShareLink, consumeShareLinkRoom } from '../lib/shareLink';

/** Unambiguous alphabet (no 0/O/1/l/i) with ~59 bits of entropy, grouped for
 * readability. Room codes are the only thing gating access, so they must be
 * hard to guess: a CSPRNG is used, never Math.random. */
function randomInviteCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < bytes.length; i++) {
    code += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i !== bytes.length - 1) code += '-';
  }
  return code;
}

type Mode = 'start' | 'join' | 'contacts';

/**
 * Landing screen. First-time users get one obvious primary action — start a
 * new chat — with joining-by-code and saved contacts presented as clearly
 * separate, equally-weighted alternatives rather than an ambiguous 2-way tab.
 */
export function JoinRoom() {
  const join = useChatStore((s) => s.join);
  const status = useChatStore((s) => s.status);
  const errorText = useChatStore((s) => s.errorText);

  const [mode, setMode] = useState<Mode>('start');
  const [name, setName] = useState('');
  // Pre-generated so the default ("start a new chat") screen never shows an
  // empty, unexplained code field — the whole point is to remove the extra
  // "now click New" step that used to gate the most common first action.
  const [room, setRoom] = useState(() => randomInviteCode());
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [imported, setImported] = useState(false);
  const [fromLink, setFromLink] = useState(false);
  // Only meaningful when *creating* a room — it's fixed server-side at
  // creation (see rooms.ts Room.ephemeral) and can't be changed by whoever
  // joins later, so there's no toggle on the "Have a code" tab.
  const [ephemeral, setEphemeral] = useState(false);

  const nameId = useId();
  const roomId = useId();
  const hintId = useId();
  const errorId = useId();
  const ephemeralId = useId();

  // A share link (see buildShareLink below) drops the room code in the URL
  // fragment. Pick it up once on mount, land straight on the join tab with
  // it prefilled, and scrub the fragment from the address bar immediately —
  // this never auto-joins, so opening the link (e.g. a chat-app link
  // preview bot fetching the page) can't silently seat a ghost participant.
  useEffect(() => {
    const linkedRoom = consumeShareLinkRoom();
    if (linkedRoom) {
      setRoom(linkedRoom);
      setMode('join');
      setFromLink(true);
    }
  }, []);

  const connecting = status === 'connecting';
  const trimmedRoom = room.trim();
  const canSubmit = trimmedRoom.length > 0 && !connecting;

  function selectMode(next: Mode) {
    setMode(next);
    setCopied(false);
    setLinkCopied(false);
    if (next === 'start') setRoom(randomInviteCode());
    if (next === 'join') setRoom('');
  }

  function regenerate() {
    setRoom(randomInviteCode());
    setCopied(false);
    setLinkCopied(false);
  }

  async function copyCode() {
    if (!trimmedRoom) return;
    try {
      await navigator.clipboard.writeText(trimmedRoom);
      setCopied(true);
    } catch {
      // Clipboard permission denied or unavailable — nothing to recover,
      // the user still has the code visible in the field to select by hand.
    }
  }

  async function copyLink() {
    if (!trimmedRoom) return;
    try {
      await navigator.clipboard.writeText(buildShareLink(trimmedRoom));
      setLinkCopied(true);
    } catch {
      // Same as copyCode: fail silently, code is still selectable manually.
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (connecting) return;
    const trimmedName = name.trim() || 'Anonymous';
    if (!trimmedRoom) return;
    void join(trimmedRoom, trimmedName, mode === 'start' && ephemeral);
  }

  return (
    <div className="relative flex h-full items-start justify-center overflow-y-auto bg-wa-bg p-4">
      {/* Layered "secure" backdrop: green wash up top fading into the app base. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-wa-green-dark to-wa-bg" />
      <div className="pointer-events-none absolute left-1/2 top-8 h-72 w-72 -translate-x-1/2 rounded-full bg-wa-green/20 blur-3xl" />

      <div className="relative my-auto w-full max-w-sm animate-pop-in rounded-2xl bg-wa-panel p-5 shadow-2xl ring-1 ring-wa-border motion-reduce:animate-none sm:p-6">
        <header className="mb-4 text-center">
          <div className="relative mx-auto mb-2.5 flex h-12 w-12 items-center justify-center">
            {/* Soft halo behind the lock to reinforce the privacy cue. */}
            <span className="absolute inset-0 rounded-full bg-wa-green/25 blur-md" aria-hidden="true" />
            <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-wa-green text-white shadow-lg shadow-wa-green/30 ring-1 ring-white/10">
              <Lock className="h-5 w-5" />
            </span>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-wa-primary">Whisper</h1>
          <p className="mx-auto mt-1 text-xs text-wa-secondary">
            End-to-end encrypted chat &amp; calls for {ROOM_MIN_PEERS}&ndash;{ROOM_MAX_PEERS} people
          </p>
        </header>

        <Field label="Your name" htmlFor={nameId} hint="Optional — defaults to Anonymous">
          <FieldShell icon={<Users className="h-4 w-4" />}>
            <input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              maxLength={64}
              autoComplete="off"
              disabled={connecting}
              className="w-full bg-transparent text-sm text-wa-primary outline-none placeholder:text-wa-secondary disabled:opacity-60"
            />
          </FieldShell>
        </Field>

        <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-wa-input p-1 text-xs font-medium">
          <ModeTab active={mode === 'start'} onClick={() => selectMode('start')}>
            Start new
          </ModeTab>
          <ModeTab active={mode === 'join'} onClick={() => selectMode('join')}>
            Have a code
          </ModeTab>
          <ModeTab active={mode === 'contacts'} onClick={() => selectMode('contacts')}>
            Contacts
          </ModeTab>
        </div>

        {mode === 'contacts' ? (
          <div className="mt-3">
            <ContactsPanel myDisplayName={name} />
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-3 space-y-3" aria-busy={connecting} noValidate>
            <Field label="Invite code" htmlFor={roomId}>
              <div className="flex gap-2">
                <FieldShell icon={<Lock className="h-4 w-4" />}>
                  <input
                    id={roomId}
                    value={room}
                    onChange={(e) => {
                      setRoom(e.target.value);
                      setCopied(false);
                      setLinkCopied(false);
                      setFromLink(false);
                    }}
                    placeholder={mode === 'join' ? 'Paste the code you were sent' : 'e.g. garden-42'}
                    maxLength={128}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={connecting}
                    aria-invalid={Boolean(errorText)}
                    aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
                    className="w-full bg-transparent font-mono text-sm tracking-wide text-wa-primary outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-wa-secondary disabled:opacity-60"
                  />
                </FieldShell>
                {mode === 'start' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void copyCode()}
                      disabled={connecting || !trimmedRoom}
                      aria-label="Copy invite code"
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-wa-input px-3 text-xs font-medium text-wa-secondary ring-1 ring-transparent transition hover:text-wa-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {copied ? <Check className="h-4 w-4 text-wa-green" /> : 'Copy'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyLink()}
                      disabled={connecting || !trimmedRoom}
                      aria-label="Copy invite link"
                      title="Copy a shareable link"
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-wa-input px-3 text-xs font-medium text-wa-secondary ring-1 ring-transparent transition hover:text-wa-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {linkCopied ? (
                        <Check className="h-4 w-4 text-wa-green" />
                      ) : (
                        <LinkIcon className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={regenerate}
                      disabled={connecting}
                      aria-label="Generate a new invite code"
                      className="flex shrink-0 items-center justify-center rounded-lg bg-wa-input px-3 text-xs font-medium text-wa-secondary ring-1 ring-transparent transition hover:text-wa-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Refresh className="h-4 w-4" />
                    </button>
                  </>
                ) : null}
              </div>
              <p id={hintId} className="mt-1.5 text-xs text-wa-secondary">
                {mode === 'start'
                  ? `Share with up to ${ROOM_MAX_PEERS - 1} people — the room disappears once everyone leaves.`
                  : fromLink
                    ? 'Code filled in from your invite link — add a name and join whenever you\'re ready.'
                    : 'Ask the person who invited you for their code, then enter it above.'}
              </p>
            </Field>

            {mode === 'start' && (
              <label
                htmlFor={ephemeralId}
                title="Nothing about this room — not messages, not who joined — is ever written to the server's database. History and offline delivery won't work, and it can't be turned on later once the room exists."
                className="flex cursor-pointer items-center gap-2.5 rounded-lg bg-wa-input px-3.5 py-2.5 ring-1 ring-transparent transition has-[:checked]:ring-wa-green"
              >
                <Flame className="h-4 w-4 shrink-0 text-wa-secondary" />
                <span className="flex-1 text-sm font-medium text-wa-primary">Temporary chat</span>
                <span className="text-[11px] text-wa-secondary">Nothing saved</span>
                <input
                  id={ephemeralId}
                  type="checkbox"
                  checked={ephemeral}
                  onChange={(e) => setEphemeral(e.target.checked)}
                  disabled={connecting}
                  className="h-4 w-4 shrink-0 accent-wa-green"
                />
              </label>
            )}

            {errorText && (
              <p
                id={errorId}
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 ring-1 ring-red-500/20"
              >
                <Shield className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{errorText}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-wa-green py-2.5 text-sm font-semibold text-white shadow-lg shadow-wa-green/20 transition hover:bg-wa-green-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green focus-visible:ring-offset-2 focus-visible:ring-offset-wa-panel disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {connecting ? (
                <>
                  <Spinner /> Connecting&hellip;
                </>
              ) : mode === 'start' ? (
                <>
                  Start chat <Plus className="h-4 w-4" aria-hidden="true" />
                </>
              ) : (
                <>
                  Join chat <ArrowLeft className="h-4 w-4 rotate-180" aria-hidden="true" />
                </>
              )}
            </button>
          </form>
        )}

        <div className="mt-5 flex items-center justify-center gap-4 border-t border-wa-border pt-3.5 text-[11px] text-wa-secondary">
          <Badge icon={<Lock className="h-3.5 w-3.5" />}>E2E encrypted</Badge>
          <Badge icon={<Users className="h-3.5 w-3.5" />}>
            {ROOM_MIN_PEERS}&ndash;{ROOM_MAX_PEERS} people
          </Badge>
          <Badge icon={<Shield className="h-3.5 w-3.5" />}>No accounts</Badge>
        </div>

        <div className="mt-3 text-center">
          {imported ? (
            <p className="text-xs text-wa-green">Identity imported — join a chat to use it.</p>
          ) : (
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="text-xs text-wa-secondary underline decoration-dotted transition hover:text-wa-primary"
            >
              Set up this device with an existing identity
            </button>
          )}
        </div>
      </div>

      {importOpen && (
        <ImportIdentityModal
          onClose={() => setImportOpen(false)}
          onImported={() => setImported(true)}
        />
      )}

      <DocsLink />
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-wa-secondary">{label}</span>
        {hint && <span className="text-[11px] text-wa-secondary/70">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

/** Input wrapper with a leading icon and a focus-within ring for clear affordance. */
function FieldShell({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-wa-input px-3.5 py-2.5 ring-1 ring-transparent transition focus-within:ring-2 focus-within:ring-wa-green">
      <span className="text-wa-secondary" aria-hidden="true">
        {icon}
      </span>
      {children}
    </div>
  );
}

/** One entry in the start/join/contacts segmented choice. */
function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md py-1.5 text-center transition ${
        active ? 'bg-wa-green text-white' : 'text-wa-secondary hover:text-wa-primary'
      }`}
    >
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white"
      aria-hidden="true"
    />
  );
}

function Badge({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-wa-green">{icon}</span>
      {children}
    </span>
  );
}
