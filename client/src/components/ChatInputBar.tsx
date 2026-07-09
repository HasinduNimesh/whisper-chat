/**
 * Presentational WhatsApp-style message bar. Owns the draft; Enter sends,
 * Shift+Enter inserts a newline. Store-agnostic — Composer (private chat)
 * and the dashboard/widget conversation views all wrap this.
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Smiley, Paperclip, Send, Mic } from './icons';

export function ChatInputBar({
  onSend,
  disabled = false,
  placeholder = 'Type a message',
  showExtras = true,
  onDraftChange,
  onBlur,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Emoji/attach/mic affordances (private-chat look). */
  showExtras?: boolean;
  /** Hooks for typing indicators — called with the raw draft on each change. */
  onDraftChange?: (value: string) => void;
  onBlur?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const hasText = draft.trim().length > 0;

  function change(value: string) {
    setDraft(value);
    onDraftChange?.(value);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!hasText || disabled) return;
    onSend(draft);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(e);
    }
  }

  const iconButton =
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-wa-secondary transition hover:bg-white/10 hover:text-wa-primary';

  return (
    <form onSubmit={submit} className="flex items-end gap-2 bg-wa-header px-3 py-2.5">
      {showExtras && (
        <>
          <button type="button" title="Emoji" className={iconButton}>
            <Smiley className="h-6 w-6" />
          </button>
          <button type="button" title="Attach" className={iconButton}>
            <Paperclip className="h-6 w-6" />
          </button>
        </>
      )}

      <textarea
        value={draft}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        rows={1}
        placeholder={placeholder}
        className="max-h-32 min-h-[42px] flex-1 resize-none rounded-lg bg-wa-input px-4 py-2.5 text-sm outline-none placeholder:text-wa-secondary scrollbar-thin"
      />

      <button
        type="submit"
        disabled={disabled}
        title={hasText || !showExtras ? 'Send' : 'Voice message'}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-wa-green text-white shadow-sm transition hover:bg-wa-green-dark disabled:cursor-not-allowed disabled:opacity-40"
      >
        {hasText || !showExtras ? <Send className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </button>
    </form>
  );
}
