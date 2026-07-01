import { useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { exportIdentity, importIdentity, saveIdentity } from '../crypto';
import { Modal, Warning, ErrorText, PrimaryButton, SecondaryButton, inputClass } from './ModalKit';

/**
 * Passphrase-protected identity export, so a user can carry the same X25519
 * keypair to a second device (otherwise each browser generates its own, and
 * "the same person" looks like two different identities to the protocol).
 * Shown from the in-session Sidebar menu, since an identity only exists once
 * you've joined a room at least once.
 */
export function ExportIdentityModal({ onClose }: { onClose: () => void }) {
  const identity = useChatStore((s) => s.identity);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [blob, setBlob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reveal() {
    if (!identity) return;
    if (passphrase.length < 8) {
      setError('Use a passphrase of at least 8 characters.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases don't match.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      setBlob(await exportIdentity(identity, passphrase));
    } catch {
      setError('Could not create the export code.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!blob) return;
    await navigator.clipboard.writeText(blob);
    setCopied(true);
  }

  return (
    <Modal title="Export identity" onClose={onClose}>
      {!blob ? (
        <>
          <Warning>
            This creates a passphrase-protected code containing your entire encryption
            identity. Anyone who gets this code <strong>and</strong> your passphrase can read all
            your messages and impersonate you. Only use this to set up your own other device —
            never share it with anyone else.
          </Warning>
          <div className="space-y-2">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Choose a passphrase"
              autoComplete="new-password"
              className={inputClass}
            />
            <input
              type="password"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              placeholder="Confirm passphrase"
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          <PrimaryButton onClick={() => void reveal()} disabled={busy}>
            {busy ? 'Deriving key…' : 'Reveal export code'}
          </PrimaryButton>
        </>
      ) : (
        <>
          <p className="text-xs text-wa-secondary">
            Copy this to your other device, then use &quot;Import identity&quot; there with the
            same passphrase.
          </p>
          <textarea
            readOnly
            value={blob}
            rows={5}
            onFocus={(e) => e.currentTarget.select()}
            className={`${inputClass} resize-none font-mono text-[11px] leading-relaxed`}
          />
          <PrimaryButton onClick={() => void copy()}>
            {copied ? 'Copied ✓' : 'Copy to clipboard'}
          </PrimaryButton>
          <SecondaryButton onClick={onClose}>Done</SecondaryButton>
        </>
      )}
    </Modal>
  );
}

/**
 * Paste an export code + passphrase to install that identity on this device,
 * before joining any room (see JoinRoom.tsx) — swapping identity mid-session
 * would leave you unable to address messages under the room's existing view
 * of who you are, so this is deliberately a pre-join-only action.
 */
export function ImportIdentityModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [blob, setBlob] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doImport() {
    setError(null);
    setBusy(true);
    try {
      const identity = await importIdentity(blob.trim(), passphrase);
      saveIdentity(identity);
      onImported();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Import identity" onClose={onClose}>
      <Warning>
        This replaces this device&apos;s encryption identity with the one from your export code.
        Only do this on a device you trust, using a code you created yourself.
      </Warning>
      <textarea
        value={blob}
        onChange={(e) => setBlob(e.target.value)}
        rows={4}
        placeholder="Paste your export code"
        className={`${inputClass} resize-none font-mono text-[11px] leading-relaxed`}
      />
      <input
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Passphrase"
        autoComplete="current-password"
        className={inputClass}
      />
      <label className="flex items-start gap-2 text-xs text-wa-secondary">
        <input
          type="checkbox"
          checked={confirmOverwrite}
          onChange={(e) => setConfirmOverwrite(e.target.checked)}
          className="mt-0.5"
        />
        I understand this replaces this device&apos;s identity.
      </label>
      {error && <ErrorText>{error}</ErrorText>}
      <PrimaryButton
        onClick={() => void doImport()}
        disabled={busy || !confirmOverwrite || !blob.trim() || !passphrase}
      >
        {busy ? 'Importing…' : 'Import identity'}
      </PrimaryButton>
    </Modal>
  );
}
