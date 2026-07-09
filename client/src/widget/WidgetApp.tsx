/** The chat panel rendered inside the embed iframe. */
import { ChatLog, type DisplayMessage } from '../components/ChatLog';
import { ChatInputBar } from '../components/ChatInputBar';
import { Avatar } from '../components/Avatar';
import { Lock } from '../components/icons';
import { useWidgetStore } from './useWidgetStore';

export function WidgetApp({
  primaryColor,
  onCloseRequest,
}: {
  primaryColor: string;
  onCloseRequest: () => void;
}) {
  const status = useWidgetStore((s) => s.status);
  const error = useWidgetStore((s) => s.error);
  const orgName = useWidgetStore((s) => s.orgName);
  const encryption = useWidgetStore((s) => s.encryption);
  const conversationStatus = useWidgetStore((s) => s.conversationStatus);
  const connected = useWidgetStore((s) => s.connected);
  const participants = useWidgetStore((s) => s.participants);
  const messages = useWidgetStore((s) => s.messages);
  const sendMessage = useWidgetStore((s) => s.sendMessage);

  const agentOnline = participants.some((p) => p.kind === 'agent' && p.online);
  const closed = conversationStatus === 'closed';
  const title = orgName || 'Chat';

  const display: DisplayMessage[] = messages.map((m) => ({
    id: m.id,
    mine: m.mine,
    fromKey: m.fromKey,
    fromName: m.fromName,
    text: m.text,
    sentAt: m.sentAt,
    ticks: false,
  }));

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-wa-panel">
      <header
        className="flex items-center gap-2.5 px-3 py-2.5 text-white"
        style={{ background: primaryColor }}
      >
        <Avatar name={title} size="sm" online={agentOnline} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-[11px] opacity-80">
            {status !== 'ready' ? 'Connecting…' : agentOnline ? 'We’re online' : 'We’ll reply as soon as we can'}
          </p>
        </div>
        <button
          onClick={onCloseRequest}
          aria-label="Close chat"
          className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-white/15"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      {status === 'error' ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-wa-secondary">
          {error ?? 'Chat is unavailable right now.'}
        </div>
      ) : (
        <>
          {error && (
            <p role="alert" className="bg-red-500/10 px-3 py-1.5 text-xs text-red-400">
              {error}
            </p>
          )}
          <ChatLog
            messages={display}
            emptyText={status === 'ready' ? 'Say hello — we’re listening 👋' : 'Connecting…'}
            banner={
              encryption === 'e2e' ? (
                <span className="mb-3 flex items-center gap-1.5 rounded-lg bg-wa-header/90 px-3 py-1.5 text-center text-[11px] text-wa-secondary shadow-sm">
                  <Lock className="h-3 w-3" />
                  End-to-end encrypted
                </span>
              ) : undefined
            }
          />
          <ChatInputBar
            onSend={sendMessage}
            disabled={closed || !connected}
            placeholder={closed ? 'This conversation was closed' : connected ? 'Type a message' : 'Connecting…'}
            showExtras={false}
          />
        </>
      )}
    </div>
  );
}
