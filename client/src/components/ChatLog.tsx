/**
 * Presentational WhatsApp-style chat log: wallpaper, grouped bubbles, date
 * separators, auto-scroll. Store-agnostic — the private-chat MessageList and
 * the org dashboard/widget all render through this with their own message
 * shapes mapped to DisplayMessage.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { nameColor } from '../lib/avatar';
import { Avatar } from './Avatar';
import { CheckCheck } from './icons';

const GROUP_GAP_MS = 5 * 60 * 1000; // new visual group after a 5-min gap

export interface DisplayMessage {
  id: string;
  mine: boolean;
  /** Stable sender key for visual grouping (peer id / participant id). */
  fromKey: string;
  fromName: string;
  text: string;
  sentAt: number;
  /** Show read ticks on own bubbles (private chat); off for org chats. */
  ticks?: boolean;
}

export function ChatLog({
  messages,
  banner,
  emptyText = 'No messages yet — say hello 👋',
  tail,
}: {
  messages: DisplayMessage[];
  /** Pinned notice at the top (e.g. the E2E banner). */
  banner?: ReactNode;
  emptyText?: string;
  /** Rendered after the last message (e.g. a typing indicator). */
  tail?: ReactNode;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages.length, tail !== undefined && tail !== null && tail !== false]);

  return (
    <div className="wa-chat-bg scrollbar-thin flex-1 overflow-y-auto px-4 py-4 md:px-[8%]">
      {banner && <div className="mx-auto flex justify-center">{banner}</div>}

      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center pb-16 text-center text-wa-secondary">
          <p className="text-sm">{emptyText}</p>
        </div>
      ) : (
        messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const newDay = !prev || !sameDay(prev.sentAt, m.sentAt);
          const startsGroup =
            newDay || prev.fromKey !== m.fromKey || m.sentAt - prev.sentAt > GROUP_GAP_MS;
          const endsGroup =
            !next ||
            next.fromKey !== m.fromKey ||
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
      {tail}
      <div ref={bottomRef} />
    </div>
  );
}

function Bubble({
  m,
  startsGroup,
  endsGroup,
}: {
  m: DisplayMessage;
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
            {m.ticks !== false && <CheckCheck className="h-3 w-3 text-wa-tick" />}
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
