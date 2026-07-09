import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useInboxStore, type InboxFilter } from '../useInboxStore';
import type { ConversationDto } from '../api';
import { Shell } from './shared';

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'mine', label: 'Mine' },
  { key: 'open', label: 'All open' },
  { key: 'closed', label: 'Closed' },
];

export function InboxPage() {
  const conversations = useInboxStore((s) => s.conversations);
  const filter = useInboxStore((s) => s.filter);
  const setFilter = useInboxStore((s) => s.setFilter);
  const loadConversations = useInboxStore((s) => s.loadConversations);
  const loading = useInboxStore((s) => s.inboxLoading);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 overflow-y-auto p-4 scrollbar-thin">
        <div className="flex gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === f.key
                  ? 'bg-wa-green text-white'
                  : 'bg-wa-input text-wa-secondary hover:text-wa-primary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {conversations.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-wa-secondary">
            {loading ? 'Loading…' : 'No conversations here yet.'}
          </div>
        ) : (
          <ul className="divide-y divide-wa-border overflow-hidden rounded-xl bg-wa-panel">
            {conversations.map((c) => (
              <ConversationRow key={c.id} c={c} />
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}

function ConversationRow({ c }: { c: ConversationDto }) {
  const customer = c.participants?.find((p) => p.kind !== 'agent');
  const title = customer?.displayName ?? 'Conversation';
  const context = c.context as { listing?: string; title?: string; url?: string } | null;
  const contextLine = context?.listing ?? context?.title;
  const when = c.lastMessageAt ?? c.createdAt;

  return (
    <li>
      <Link
        to={`/c/${c.id}`}
        className="flex items-center gap-3 px-4 py-3 transition hover:bg-wa-hover"
      >
        <Avatar name={title} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-wa-primary">{title}</span>
            <span className="rounded bg-wa-input px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-wa-secondary">
              {c.kind}
            </span>
            {c.status === 'closed' && (
              <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-400">
                closed
              </span>
            )}
            {!c.assignedAgentId && c.status === 'open' && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                unassigned
              </span>
            )}
          </div>
          {contextLine && <p className="truncate text-xs text-wa-secondary">{contextLine}</p>}
        </div>
        <span className="shrink-0 text-[11px] text-wa-secondary">
          {new Date(when).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </Link>
    </li>
  );
}
