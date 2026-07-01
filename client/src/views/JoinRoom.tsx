import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useChatStore } from '../store/useChatStore';
import { ROOM_MIN_PEERS, ROOM_MAX_PEERS } from '@private-chat/shared';
import { Lock, Shield, Users, Plus, ArrowLeft } from '../components/icons';
import { DocsLink } from '../components/DocsLink';
import { ImportIdentityModal } from '../components/IdentityBackup';
import { ContactsPanel } from '../components/Contacts';

/** Landing screen: pick a display name, then join a room or open a contact. */
export function JoinRoom() {
  const join = useChatStore((s) => s.join);
  const status = useChatStore((s) => s.status);
  const errorText = useChatStore((s) => s.errorText);

  const [tab, setTab] = useState<'room' | 'contacts'>('room');
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [imported, setImported] = useState(false);

  const nameId = useId();
  const roomId = useId();
  const hintId = useId();
  const errorId = useId();

  const connecting = status === 'connecting';
  const trimmedRoom = room.trim();
  const canJoin = trimmedRoom.length > 0 && !connecting;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (connecting) return;
    const trimmedName = name.trim() || 'Anonymous';
    if (!trimmedRoom) return;
    void join(trimmedRoom, trimmedName);
  }

  function generateRoom() {
    // Room codes are the only thing gating access, so they must be hard to
    // guess: use a CSPRNG (not Math.random) with ~59 bits of entropy over an
    // unambiguous alphabet (no 0/O/1/l/i), grouped for readability.
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < bytes.length; i++) {
      code += alphabet[bytes[i] % alphabet.length];
      if (i % 4 === 3 && i !== bytes.length - 1) code += '-';
    }
    setRoom(code);
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-wa-bg p-4">
      {/* Layered "secure" backdrop: green wash up top fading into the app base. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-wa-green-dark to-wa-bg" />
      <div className="pointer-events-none absolute left-1/2 top-8 h-72 w-72 -translate-x-1/2 rounded-full bg-wa-green/20 blur-3xl" />

      <div className="relative w-full max-w-sm animate-pop-in rounded-2xl bg-wa-panel p-6 shadow-2xl ring-1 ring-wa-border motion-reduce:animate-none sm:p-8">
        <header className="mb-7 text-center">
          <div className="relative mx-auto mb-4 flex h-16 w-16 items-center justify-center">
            {/* Soft halo behind the lock to reinforce the privacy cue. */}
            <span className="absolute inset-0 rounded-full bg-wa-green/25 blur-md" aria-hidden="true" />
            <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-wa-green text-white shadow-lg shadow-wa-green/30 ring-1 ring-white/10">
              <Lock className="h-7 w-7" />
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-wa-primary">Whisper</h1>
          <p className="mx-auto mt-1.5 max-w-[16rem] text-sm text-wa-secondary">
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

        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-wa-input p-1 text-xs font-medium">
          <button
            type="button"
            onClick={() => setTab('room')}
            className={`rounded-md py-1.5 transition ${tab === 'room' ? 'bg-wa-green text-white' : 'text-wa-secondary hover:text-wa-primary'}`}
          >
            Join a room
          </button>
          <button
            type="button"
            onClick={() => setTab('contacts')}
            className={`rounded-md py-1.5 transition ${tab === 'contacts' ? 'bg-wa-green text-white' : 'text-wa-secondary hover:text-wa-primary'}`}
          >
            Contacts
          </button>
        </div>

        {tab === 'contacts' ? (
          <div className="mt-4">
            <ContactsPanel myDisplayName={name} />
          </div>
        ) : (
        <form onSubmit={onSubmit} className="mt-4 space-y-4" aria-busy={connecting} noValidate>
          <Field label="Room code" htmlFor={roomId}>
            <div className="flex gap-2">
              <FieldShell icon={<Lock className="h-4 w-4" />}>
                <input
                  id={roomId}
                  value={room}
                  onChange={(e) => setRoom(e.target.value)}
                  placeholder="e.g. garden-42"
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
              <button
                type="button"
                onClick={generateRoom}
                disabled={connecting}
                aria-label="Generate a random room code"
                className="flex shrink-0 items-center gap-1 rounded-lg bg-wa-input px-3 text-xs font-medium text-wa-secondary ring-1 ring-transparent transition hover:text-wa-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" /> New
              </button>
            </div>
            <p id={hintId} className="mt-1.5 text-xs text-wa-secondary">
              Share this code with up to {ROOM_MAX_PEERS - 1} others to talk privately.
            </p>
          </Field>

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
            disabled={!canJoin}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-wa-green py-2.5 text-sm font-semibold text-white shadow-lg shadow-wa-green/20 transition hover:bg-wa-green-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green focus-visible:ring-offset-2 focus-visible:ring-offset-wa-panel disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            {connecting ? (
              <>
                <Spinner /> Connecting&hellip;
              </>
            ) : (
              <>
                Join room <ArrowLeft className="h-4 w-4 rotate-180" aria-hidden="true" />
              </>
            )}
          </button>
        </form>
        )}

        <div className="mt-7 flex items-center justify-center gap-4 border-t border-wa-border pt-5 text-[11px] text-wa-secondary">
          <Badge icon={<Lock className="h-3.5 w-3.5" />}>E2E encrypted</Badge>
          <Badge icon={<Users className="h-3.5 w-3.5" />}>
            {ROOM_MIN_PEERS}&ndash;{ROOM_MAX_PEERS} people
          </Badge>
          <Badge icon={<Shield className="h-3.5 w-3.5" />}>No accounts</Badge>
        </div>

        <div className="mt-4 text-center">
          {imported ? (
            <p className="text-xs text-wa-green">Identity imported — join a room to use it.</p>
          ) : (
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="text-xs text-wa-secondary underline decoration-dotted transition hover:text-wa-primary"
            >
              Already have an identity from another device?
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
