import { useChatStore } from '../store/useChatStore';
import { typingNames } from '../lib/typing';
import { Avatar } from './Avatar';
import { Lock } from './icons';
import { ChatLog, type DisplayMessage } from './ChatLog';

/** The private-chat message log: store-bound wrapper around ChatLog. */
export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const typingPeers = useChatStore((s) => s.typingPeers);
  const peers = useChatStore((s) => s.peers);

  const whoTyping = typingNames(typingPeers, peers);
  const someoneTyping = whoTyping.length > 0;

  const display: DisplayMessage[] = messages.map((m) => ({
    id: m.id,
    mine: m.mine,
    fromKey: m.fromPeerId,
    fromName: m.fromName,
    text: m.text,
    sentAt: m.sentAt,
  }));

  return (
    <ChatLog
      messages={display}
      banner={
        <span className="mb-3 flex items-center gap-1.5 rounded-lg bg-wa-header/90 px-3 py-1.5 text-center text-[11px] text-wa-secondary shadow-sm">
          <Lock className="h-3 w-3" />
          Messages are end-to-end encrypted. No one outside this room can read them.
        </span>
      }
      tail={
        someoneTyping ? (
          <TypingIndicator name={whoTyping.length === 1 ? whoTyping[0] : undefined} />
        ) : undefined
      }
    />
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
