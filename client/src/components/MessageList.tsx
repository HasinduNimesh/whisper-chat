import { useEffect, useRef } from 'react';
import { useChatStore, type ChatMessage } from '../store/useChatStore';
import { nameColor } from '../lib/avatar';
import { typingNames } from '../lib/typing';
import { Avatar } from './Avatar';
import { Lock, CheckCheck } from './icons';

const GROUP_GAP_MS = 5 * 60 * 1000; // new visual group after a 5-min gap

/** WhatsApp-style chat log: wallpaper, grouped bubbles, date separators. */
export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const typingPeers = useChatStore((s) => s.typingPeers);
  const peers = useChatStore((s) => s.peers);
  const bottomRef = useRef<HTMLDivElement>(null);

  const whoTyping = typingNames(typingPeers, peers);
  const someoneTyping = whoTyping.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, someoneTyping]);

  return (
    <div className="wa-chat-bg scrollbar-thin flex-1 overflow-y-auto px-4 py-4 md:px-[8%]">
      <div className="mx-auto flex justify-center">
        <span className="mb-3 flex items-center gap-1.5 rounded-lg bg-wa-header/90 px-3 py-1.5 text-center text-[11px] text-wa-secondary shadow-sm">
          <Lock className="h-3 w-3" />
          Messages are end-to-end encrypted. No one outside this room can read them.
        </span>
      </div>

      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center pb-16 text-center text-wa-secondary">
          <p className="text-sm">No messages yet — say hello 👋</p>
        </div>
      ) : (
        messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const newDay = !prev || !sameDay(prev.sentAt, m.sentAt);
          const startsGroup =
            newDay || prev.fromPeerId !== m.fromPeerId || m.sentAt - prev.sentAt > GROUP_GAP_MS;
          const endsGroup =
            !next ||
            next.fromPeerId !== m.fromPeerId ||
            !sameDay(m.sentAt, next.sentAt) ||
            next.sentAt - m.sentAt > GROUP_GAP_MS;
          return (
            <div key={m.id}>
              {newDay && <DaySeparator ts={m.sentAt} />}
              <Bubble m={m} startsGroup={startsGroup} endsGroup={endsGroup} />
            </div>
          );
        })
      )}
      {someoneTyping && <TypingIndicator name={whoTyping.length === 1 ? whoTyping[0] : undefined} />}
      <div ref={bottomRef} />
    </div>
  );
}

/** Incoming-style bubble with animated dots while a peer is typing. */
function TypingIndicator({ name }: { name?: string }) {
  return (
    <div className="mt-2.5 flex items-end gap-2">
      <div className="w-7 shrink-0">{name && <Avatar name={name} size="sm" />}</div>
      <div className="flex items-center gap-1 rounded-lg rounded-tl-none bg-wa-bubble-in px-3 py-2.5 shadow-sm">
        {[0, 0.15, 0.3].map((delay) => (
          <span
            key={delay}
            className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-wa-secondary motion-reduce:animate-none"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </div>
    </div>
  );
}

function Bubble({
  m,
  startsGroup,
  endsGroup,
}: {
  m: ChatMessage;
  startsGroup: boolean;
  endsGroup: boolean;
}) {
  const time = new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (m.mine) {
    return (
      <div className={`flex justify-end ${startsGroup ? 'mt-2.5' : 'mt-0.5'}`}>
        <div
          className={`relative flex max-w-[75%] flex-col animate-pop-in rounded-lg bg-wa-bubble-out px-2.5 py-1.5 text-sm text-wa-primary shadow-sm ${
            startsGroup ? 'wa-tail-out rounded-tr-none' : ''
          }`}
        >
          <span className="whitespace-pre-wrap break-words">{m.text}</span>
          <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] leading-none text-wa-primary/60">
            {time}
            <CheckCheck className="h-3 w-3 text-wa-tick" />
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-end gap-2 ${startsGroup ? 'mt-2.5' : 'mt-0.5'}`}>
      <div className="w-7 shrink-0">{endsGroup && <Avatar name={m.fromName} size="sm" />}</div>
      <div
        className={`relative flex max-w-[75%] flex-col animate-pop-in rounded-lg bg-wa-bubble-in px-2.5 py-1.5 text-sm text-wa-primary shadow-sm ${
          startsGroup ? 'wa-tail-in rounded-tl-none' : ''
        }`}
      >
        {startsGroup && (
          <span className={`mb-0.5 text-xs font-medium ${nameColor(m.fromName)}`}>{m.fromName}</span>
        )}
        <span className="whitespace-pre-wrap break-words">{m.text}</span>
        <span className="mt-0.5 self-end text-[10px] leading-none text-wa-secondary">{time}</span>
      </div>
    </div>
  );
}

function DaySeparator({ ts }: { ts: number }) {
  return (
    <div className="my-3 flex justify-center">
      <span className="rounded-lg bg-wa-header/90 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-wa-secondary shadow-sm">
        {formatDay(ts)}
      </span>
    </div>
  );
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.toDateString() === db.toDateString();
}

function formatDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}
