import { useEffect, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { api, type ApiKeyDto } from '../api';
import { useInboxStore } from '../useInboxStore';
import { Shell, fieldClass } from './shared';

export function SettingsPage() {
  const user = useInboxStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto p-4 scrollbar-thin">
        <TeamSection isAdmin={isAdmin} />
        {isAdmin && <ApiKeysSection />}
        {isAdmin && <OrgSection />}
      </div>
    </Shell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-wa-panel p-4">
      <h2 className="mb-3 text-sm font-semibold text-wa-primary">{title}</h2>
      {children}
    </section>
  );
}

const smallButton =
  'rounded-lg bg-wa-input px-3 py-1.5 text-xs text-wa-primary transition hover:bg-wa-hover disabled:opacity-50';

function TeamSection({ isAdmin }: { isAdmin: boolean }) {
  const agents = useInboxStore((s) => s.agents);
  const loadAgents = useInboxStore((s) => s.loadAgents);
  const disableAgent = useInboxStore((s) => s.disableAgent);
  const user = useInboxStore((s) => s.user);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  async function mintInvite(role: 'agent' | 'admin') {
    const { token } = await api<{ token: string }>('POST', '/api/invites', { role });
    setInviteUrl(`${location.origin}${location.pathname}#/invite/${token}`);
    setCopied(false);
  }

  return (
    <Section title="Team">
      <ul className="mb-3 divide-y divide-wa-border">
        {agents.map((a) => (
          <li key={a.id} className="flex items-center gap-3 py-2">
            <Avatar name={a.displayName} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-wa-primary">
                {a.displayName}
                {a.id === user?.id && <span className="text-wa-secondary"> (you)</span>}
              </p>
              <p className="truncate text-xs text-wa-secondary">{a.email}</p>
            </div>
            <span className="rounded bg-wa-input px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-wa-secondary">
              {a.role}
            </span>
            {a.disabled ? (
              <span className="text-[10px] uppercase text-red-400">disabled</span>
            ) : (
              isAdmin &&
              a.id !== user?.id && (
                <button onClick={() => void disableAgent(a.id)} className={smallButton}>
                  Disable
                </button>
              )
            )}
          </li>
        ))}
      </ul>

      {isAdmin && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <button onClick={() => void mintInvite('agent')} className={smallButton}>
              Invite an agent
            </button>
            <button onClick={() => void mintInvite('admin')} className={smallButton}>
              Invite an admin
            </button>
          </div>
          {inviteUrl && (
            <div className="rounded-lg bg-wa-input p-3">
              <p className="mb-1 text-xs text-wa-secondary">
                Share this single-use link (valid 7 days). It won't be shown again:
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs text-wa-primary">{inviteUrl}</code>
                <button
                  onClick={() =>
                    void navigator.clipboard.writeText(inviteUrl).then(() => setCopied(true))
                  }
                  className={smallButton}
                >
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function ApiKeysSection() {
  const apiKeys = useInboxStore((s) => s.apiKeys);
  const loadApiKeys = useInboxStore((s) => s.loadApiKeys);
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState<ApiKeyDto | null>(null);

  useEffect(() => {
    void loadApiKeys();
  }, [loadApiKeys]);

  async function createKey() {
    const { key } = await api<{ key: ApiKeyDto }>('POST', '/api/org/api-keys', { label });
    setMinted(key);
    setLabel('');
    await loadApiKeys();
  }

  async function revoke(id: string) {
    await api('DELETE', `/api/org/api-keys/${id}`);
    await loadApiKeys();
  }

  return (
    <Section title="API keys (store / marketplace integration)">
      <p className="mb-3 text-xs text-wa-secondary">
        Your store's backend signs short-lived chat tokens with these keys — see{' '}
        <code className="text-wa-primary">docs/integrations.md</code>. Secrets are shown once, at
        creation.
      </p>
      <ul className="mb-3 divide-y divide-wa-border">
        {apiKeys.map((k) => (
          <li key={k.id} className="flex items-center gap-3 py-2 text-sm">
            <code className="text-wa-primary">{k.kid}</code>
            <span className="min-w-0 flex-1 truncate text-xs text-wa-secondary">{k.label}</span>
            {k.revokedAt ? (
              <span className="text-[10px] uppercase text-red-400">revoked</span>
            ) : (
              <button onClick={() => void revoke(k.id)} className={smallButton}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          placeholder="Label (e.g. shop backend)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className={fieldClass}
        />
        <button onClick={() => void createKey()} className={smallButton}>
          Create key
        </button>
      </div>
      {minted?.secret && (
        <div className="mt-2 rounded-lg bg-wa-input p-3">
          <p className="mb-1 text-xs text-amber-400">
            Copy this secret now — it will never be shown again.
          </p>
          <p className="text-xs text-wa-secondary">
            kid: <code className="text-wa-primary">{minted.kid}</code>
          </p>
          <p className="break-all text-xs text-wa-secondary">
            secret: <code className="text-wa-primary">{minted.secret}</code>
          </p>
        </div>
      )}
    </Section>
  );
}

function OrgSection() {
  const org = useInboxStore((s) => s.org);
  const [name, setName] = useState(org?.name ?? '');
  const [saved, setSaved] = useState(false);
  const loadMe = useInboxStore((s) => s.loadMe);

  async function save() {
    await api('PATCH', '/api/org/settings', { name });
    setSaved(true);
    await loadMe();
  }

  return (
    <Section title="Organization">
      <div className="space-y-2">
        <label className="block text-xs text-wa-secondary">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${fieldClass}`} />
        </label>
        <p className="text-xs text-wa-secondary">
          Slug: <code className="text-wa-primary">{org?.slug}</code> · Encryption:{' '}
          <code className="text-wa-primary">{org?.encryptionMode}</code> (locked once conversations
          exist)
        </p>
        <button onClick={() => void save()} className={smallButton}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
      </div>
    </Section>
  );
}
