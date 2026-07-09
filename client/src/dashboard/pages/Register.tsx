import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInboxStore } from '../useInboxStore';
import { AuthShell, fieldClass, FormError, primaryButtonClass } from './shared';

export function RegisterPage() {
  const register = useInboxStore((s) => s.register);
  const authError = useInboxStore((s) => s.authError);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    orgName: '',
    slug: '',
    encryptionMode: 'managed' as 'managed' | 'e2e',
    displayName: '',
    email: '',
    password: '',
  });

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({
      ...f,
      [key]: value,
      // Suggest a slug from the name until the user edits the slug directly.
      ...(key === 'orgName' && !slugTouched
        ? { slug: String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) }
        : {}),
    }));
  }
  const [slugTouched, setSlugTouched] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await register(form);
    setBusy(false);
    if (ok) navigate('/inbox');
  }

  return (
    <AuthShell title="Create your organization">
      <p className="mb-4 text-xs text-wa-secondary">
        Self-hosted customer chat for your store or marketplace.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <input
          required
          placeholder="Organization name"
          value={form.orgName}
          onChange={(e) => update('orgName', e.target.value)}
          className={fieldClass}
        />
        <input
          required
          placeholder="URL slug (e.g. acme-store)"
          value={form.slug}
          onChange={(e) => {
            setSlugTouched(true);
            update('slug', e.target.value);
          }}
          className={fieldClass}
        />

        <fieldset className="rounded-lg border border-wa-border p-3">
          <legend className="px-1 text-xs text-wa-secondary">Conversation privacy</legend>
          <label className="flex cursor-pointer items-start gap-2 py-1 text-sm text-wa-primary">
            <input
              type="radio"
              name="mode"
              checked={form.encryptionMode === 'managed'}
              onChange={() => update('encryptionMode', 'managed')}
              className="mt-1"
            />
            <span>
              <strong>Managed</strong>
              <span className="block text-xs text-wa-secondary">
                Conversations stored on your server. Shared inbox, agent handoff, full history. Recommended for stores.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 py-1 text-sm text-wa-primary">
            <input
              type="radio"
              name="mode"
              checked={form.encryptionMode === 'e2e'}
              onChange={() => update('encryptionMode', 'e2e')}
              className="mt-1"
            />
            <span>
              <strong>End-to-end encrypted</strong>
              <span className="block text-xs text-wa-secondary">
                The server can never read messages. Each agent holds their own keys; no shared plaintext history.
              </span>
            </span>
          </label>
          <p className="mt-1 text-[11px] text-wa-secondary">
            This choice locks once your org has conversations.
          </p>
        </fieldset>

        <input
          required
          placeholder="Your name"
          autoComplete="name"
          value={form.displayName}
          onChange={(e) => update('displayName', e.target.value)}
          className={fieldClass}
        />
        <input
          type="email"
          required
          placeholder="Email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => update('email', e.target.value)}
          className={fieldClass}
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password (min 8 characters)"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => update('password', e.target.value)}
          className={fieldClass}
        />
        <FormError message={authError} />
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? 'Creating…' : 'Create organization'}
        </button>
      </form>
      <p className="mt-4 text-xs text-wa-secondary">
        Already have an account?{' '}
        <Link to="/login" className="text-wa-green hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
