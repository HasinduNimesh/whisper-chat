import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/useChatStore';
import { ChatInputBar } from './ChatInputBar';

const TYPING_HEARTBEAT_MS = 3000; // re-announce "typing" at most this often
const TYPING_IDLE_MS = 2500; // send "stopped" after this much inactivity

/** The private-chat message bar: ChatInputBar + throttled typing signals. */
export function Composer() {
  const sendText = useChatStore((s) => s.sendText);
  const sendTyping = useChatStore((s) => s.sendTyping);
  const peerCount = useChatStore((s) => Object.keys(s.peers).length);

  const alone = peerCount === 0;

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

  return (
    <ChatInputBar
      onSend={(text) => {
        stopTyping();
        sendText(text);
      }}
      disabled={alone}
      placeholder={alone ? 'Waiting for others to join…' : 'Type a message'}
      onDraftChange={onDraftChange}
      onBlur={stopTyping}
    />
  );
}
