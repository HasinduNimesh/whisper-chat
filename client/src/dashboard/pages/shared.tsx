/** Shared dashboard chrome: auth card shell + signed-in layout. */
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useInboxStore } from '../useInboxStore';

export const fieldClass =
  'w-full rounded-lg bg-wa-input px-4 py-2.5 text-sm text-wa-primary outline-none placeholder:text-wa-secondary focus:ring-1 focus:ring-wa-green';

export const primaryButtonClass =
  'w-full rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-wa-green-dark disabled:cursor-not-allowed disabled:opacity-50';

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-wa-bg px-4">
      <div className="w-full max-w-md rounded-xl bg-wa-panel p-6 shadow-lg">
        <h1 className="mb-1 text-lg font-semibold text-wa-primary">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
      {message}
    </p>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const org = useInboxStore((s) => s.org);
  const user = useInboxStore((s) => s.user);
  const logout = useInboxStore((s) => s.logout);
  const navigate = useNavigate();

  return (
    <div className="flex h-dvh flex-col bg-wa-bg">
      <header className="flex items-center justify-between border-b border-wa-border bg-wa-panel px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link to="/inbox" className="text-sm font-semibold text-wa-primary hover:text-wa-green">
            {org?.name ?? 'Dashboard'}
          </Link>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              org?.encryptionMode === 'e2e'
                ? 'bg-wa-green/15 text-wa-green'
                : 'bg-wa-input text-wa-secondary'
            }`}
            title={
              org?.encryptionMode === 'e2e'
                ? 'End-to-end encrypted conversations — the server cannot read them'
                : 'Managed conversations — stored on your org’s server'
            }
          >
            {org?.encryptionMode === 'e2e' ? 'E2E' : 'Managed'}
          </span>
        </div>
        <nav className="flex items-center gap-2">
          <Link to="/inbox" className="rounded-lg px-3 py-1.5 text-sm text-wa-secondary hover:bg-wa-hover hover:text-wa-primary">
            Inbox
          </Link>
          <Link to="/settings" className="rounded-lg px-3 py-1.5 text-sm text-wa-secondary hover:bg-wa-hover hover:text-wa-primary">
            Settings
          </Link>
          <button
            onClick={() => void logout().then(() => navigate('/login'))}
            className="rounded-lg px-3 py-1.5 text-sm text-wa-secondary hover:bg-wa-hover hover:text-wa-primary"
          >
            Sign out
          </button>
          {user && <Avatar name={user.displayName} size="sm" />}
        </nav>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
