import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useInboxStore } from '../useInboxStore';
import { AuthShell, fieldClass, FormError, primaryButtonClass } from './shared';

export function InviteAcceptPage() {
  const { token = '' } = useParams();
  const acceptInvite = useInboxStore((s) => s.acceptInvite);
  const authError = useInboxStore((s) => s.authError);
  const navigate = useNavigate();

  const [peek, setPeek] = useState<{ orgName: string; role: string } | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });

  useEffect(() => {
    api<{ orgName: string; role: string }>('GET', `/api/invites/${encodeURIComponent(token)}`)
      .then(setPeek)
      .catch(() => setPeekError('This invite link is invalid, expired, or already used.'));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await acceptInvite({ token, ...form });
    setBusy(false);
    if (ok) navigate('/inbox');
  }

  if (peekError) {
    return (
      <AuthShell title="Invite">
        <FormError message={peekError} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title={peek ? `Join ${peek.orgName}` : 'Join organization'}>
      {peek && (
        <p className="mb-4 text-xs text-wa-secondary">
          You've been invited as <strong className="text-wa-primary">{peek.role}</strong>. Create
          your account to get started.
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        <input
          required
          placeholder="Your name"
          autoComplete="name"
          value={form.displayName}
          onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
          className={fieldClass}
        />
        <input
          type="email"
          required
          placeholder="Email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          className={fieldClass}
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password (min 8 characters)"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          className={fieldClass}
        />
        <FormError message={authError} />
        <button type="submit" disabled={busy || !peek} className={primaryButtonClass}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </AuthShell>
  );
}
