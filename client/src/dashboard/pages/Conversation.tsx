import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChatLog, type DisplayMessage } from '../../components/ChatLog';
import { ChatInputBar } from '../../components/ChatInputBar';
import { Avatar } from '../../components/Avatar';
import { Lock } from '../../components/icons';
import { useInboxStore } from '../useInboxStore';
import { Shell } from './shared';

export function ConversationPage() {
  const { id = '' } = useParams();
  const active = useInboxStore((s) => s.active);
  const user = useInboxStore((s) => s.user);
  const openConversation = useInboxStore((s) => s.openConversation);
  const closeActive = useInboxStore((s) => s.closeActive);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const assignToMe = useInboxStore((s) => s.assignToMe);
  const setStatus = useInboxStore((s) => s.setConversationStatus);

  useEffect(() => {
    void openConversation(id);
    return () => closeActive();
  }, [id, openConversation, closeActive]);

  if (!active || active.id !== id) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center text-sm text-wa-secondary">Loading…</div>
      </Shell>
    );
  }

  const customer = active.participants.find((p) => p.kind !== 'agent');
  const title = customer?.displayName ?? 'Conversation';
  const context = active.detail.context as { listing?: string; title?: string; url?: string } | null;
  const closed = active.detail.status === 'closed';
  const isE2e = active.detail.encryption === 'e2e';
  const assignedToMe = active.detail.assignedAgentId === user?.id;

  const messages: DisplayMessage[] = active.messages.map((m) => ({
    id: m.id,
    mine: m.mine,
    fromKey: m.participantId,
    fromName: m.fromName,
    text: m.text,
    sentAt: m.sentAt,
    ticks: false,
  }));

  return (
    <Shell>
      <div className="flex items-center gap-3 border-b border-wa-border bg-wa-panel px-4 py-2">
        <Link to="/inbox" className="text-sm text-wa-secondary hover:text-wa-primary" title="Back to inbox">
          ←
        </Link>
        <Avatar name={title} size="sm" online={customer?.online ?? false} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-wa-primary">{title}</p>
          <p className="truncate text-[11px] text-wa-secondary">
            {customer?.online ? 'online' : 'offline'}
            {context?.listing || context?.title ? ` · ${context.listing ?? context.title}` : ''}
            {context?.url && (
              <>
                {' · '}
                <a href={context.url} target="_blank" rel="noreferrer" className="text-wa-green hover:underline">
                  view listing
                </a>
              </>
            )}
          </p>
        </div>
        {!assignedToMe && !closed && (
          <button
            onClick={() => void assignToMe()}
            className="rounded-lg bg-wa-input px-3 py-1.5 text-xs text-wa-primary transition hover:bg-wa-hover"
          >
            Assign to me
          </button>
        )}
        <button
          onClick={() => void setStatus(closed ? 'open' : 'closed')}
          className={`rounded-lg px-3 py-1.5 text-xs transition ${
            closed
              ? 'bg-wa-green text-white hover:bg-wa-green-dark'
              : 'bg-wa-input text-wa-primary hover:bg-wa-hover'
          }`}
        >
          {closed ? 'Reopen' : 'Close'}
        </button>
      </div>

      {active.error && (
        <p role="alert" className="bg-red-500/10 px-4 py-2 text-xs text-red-400">
          {active.error}
        </p>
      )}

      <ChatLog
        messages={messages}
        emptyText="No messages yet."
        banner={
          isE2e ? (
            <span className="mb-3 flex items-center gap-1.5 rounded-lg bg-wa-header/90 px-3 py-1.5 text-center text-[11px] text-wa-secondary shadow-sm">
              <Lock className="h-3 w-3" />
              End-to-end encrypted — the server cannot read this conversation.
            </span>
          ) : undefined
        }
      />

      <ChatInputBar
        onSend={sendMessage}
        disabled={closed || !active.connected}
        placeholder={
          closed ? 'Conversation is closed' : active.connected ? 'Type a reply' : 'Connecting…'
        }
        showExtras={false}
      />
    </Shell>
  );
}
