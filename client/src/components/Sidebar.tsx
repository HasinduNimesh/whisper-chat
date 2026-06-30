import { useChatStore } from '../store/useChatStore';
import { Avatar } from './Avatar';
import { Roster } from './Roster';
import { Users, Search, DotsVertical, Logout, Lock } from './icons';

/** WhatsApp-style left pane: your profile, search, the active room, participants. */
export function Sidebar() {
  const displayName = useChatStore((s) => s.displayName);
  const roomId = useChatStore((s) => s.roomId);
  const messages = useChatStore((s) => s.messages);
  const leave = useChatStore((s) => s.leave);

  const last = messages[messages.length - 1];
  const preview = last
    ? `${last.mine ? 'You: ' : ''}${last.text}`
    : 'end-to-end encrypted';
  const lastTime = last
    ? new Date(last.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="flex h-full flex-col bg-wa-panel">
      {/* Profile / app header */}
      <div className="flex items-center justify-between bg-wa-header px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Avatar name={displayName || 'You'} size="md" />
          <span className="text-sm font-medium">{displayName || 'You'}</span>
        </div>
        <div className="flex items-center gap-1 text-wa-secondary">
          <button title="Menu" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 hover:text-wa-primary">
            <DotsVertical className="h-5 w-5" />
          </button>
          <button
            onClick={leave}
            title="Leave room"
            className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 hover:text-wa-primary"
          >
            <Logout className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-3 rounded-lg bg-wa-input px-3 py-1.5">
          <Search className="h-4 w-4 text-wa-secondary" />
          <input
            placeholder="Search"
            className="w-full bg-transparent text-sm outline-none placeholder:text-wa-secondary"
          />
        </div>
      </div>

      {/* Active room as a chat-list item */}
      <button className="flex items-center gap-3 border-l-4 border-wa-green bg-wa-hover px-3 py-3 text-left">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-wa-input text-wa-secondary">
          <Users className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">Room {roomId}</span>
            {lastTime && <span className="shrink-0 text-[11px] text-wa-secondary">{lastTime}</span>}
          </div>
          <p className="truncate text-xs text-wa-secondary">{preview}</p>
        </div>
      </button>

      {/* Participants */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <Roster />
      </div>

      <div className="flex items-center justify-center gap-1.5 border-t border-wa-border py-2.5 text-[11px] text-wa-secondary">
        <Lock className="h-3 w-3" /> Your messages are end-to-end encrypted
      </div>
    </div>
  );
}
