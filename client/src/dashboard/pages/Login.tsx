import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInboxStore } from '../useInboxStore';
import { AuthShell, fieldClass, FormError, primaryButtonClass } from './shared';

export function LoginPage() {
  const login = useInboxStore((s) => s.login);
  const authError = useInboxStore((s) => s.authError);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await login(email, password);
    setBusy(false);
    if (ok) navigate('/inbox');
  }

  return (
    <AuthShell title="Sign in">
      <p className="mb-4 text-xs text-wa-secondary">Your organization's conversation dashboard.</p>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={fieldClass}
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={fieldClass}
        />
        <FormError message={authError} />
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-xs text-wa-secondary">
        New organization?{' '}
        <Link to="/register" className="text-wa-green hover:underline">
          Create one
        </Link>
      </p>
    </AuthShell>
  );
}
