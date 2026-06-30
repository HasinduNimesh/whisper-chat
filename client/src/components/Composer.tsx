import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useChatStore } from '../store/useChatStore';
import { Smiley, Paperclip, Send, Mic } from './icons';

const TYPING_HEARTBEAT_MS = 3000; // re-announce "typing" at most this often
const TYPING_IDLE_MS = 2500; // send "stopped" after this much inactivity

/** WhatsApp-style message bar. Enter sends; Shift+Enter inserts a newline. */
export function Composer() {
  const sendText = useChatStore((s) => s.sendText);
  const sendTyping = useChatStore((s) => s.sendTyping);
  const peerCount = useChatStore((s) => Object.keys(s.peers).length);
  const [draft, setDraft] = useState('');

  const alone = peerCount === 0;
  const hasText = draft.trim().length > 0;

  // Throttle outbound "typing" signals: announce on activity (at most every
  // HEARTBEAT), and announce "stopped" after a short idle or on send/blur.
  const typing = useRef({ active: false, lastSent: 0, idle: undefined as ReturnType<typeof setTimeout> | undefined });

  function stopTyping() {
    const t = typing.current;
    if (t.idle) {
      clearTimeout(t.idle);
      t.idle = undefined;
    }
    if (t.active) {
      t.active = false;
      t.lastSent = 0;
      sendTyping(false);
    }
  }

  function onDraftChange(value: string) {
    setDraft(value);
    if (alone) return;
    const t = typing.current;
    if (!value.trim()) {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (now - t.lastSent > TYPING_HEARTBEAT_MS) {
      t.active = true;
      t.lastSent = now;
      sendTyping(true);
    }
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  // Stop announcing typing if the composer unmounts mid-draft.
  useEffect(() => stopTyping, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!hasText || alone) return;
    stopTyping();
    sendText(draft);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(e);
    }
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2 bg-wa-header px-3 py-2.5">
      <button
        type="button"
        title="Emoji"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-wa-secondary transition hover:bg-white/10 hover:text-wa-primary"
      >
        <Smiley className="h-6 w-6" />
      </button>
      <button
        type="button"
        title="Attach"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-wa-secondary transition hover:bg-white/10 hover:text-wa-primary"
      >
        <Paperclip className="h-6 w-6" />
      </button>

      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={stopTyping}
        rows={1}
        placeholder={alone ? 'Waiting for others to join…' : 'Type a message'}
        className="max-h-32 min-h-[42px] flex-1 resize-none rounded-lg bg-wa-input px-4 py-2.5 text-sm outline-none placeholder:text-wa-secondary scrollbar-thin"
      />

      <button
        type="submit"
        disabled={alone}
        title={hasText ? 'Send' : 'Voice message'}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-wa-green text-white shadow-sm transition hover:bg-wa-green-dark disabled:cursor-not-allowed disabled:opacity-40"
      >
        {hasText ? <Send className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </button>
    </form>
  );
}
