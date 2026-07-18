import { useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { typingLabel, typingNames } from '../lib/typing';
import { buildShareLink } from '../lib/shareLink';
import { VIDEO_CALL_MAX_PEERS, VOICE_CALL_MAX_PEERS } from '@private-chat/shared';
import { Users, Phone, Video, Search, DotsVertical, Logout, LinkIcon, Check, Flame } from './icons';

/** Active-chat top bar: room identity + voice/video call actions. */
export function ChatHeader() {
  const roomId = useChatStore((s) => s.roomId);
  const displayName = useChatStore((s) => s.displayName);
  const ephemeral = useChatStore((s) => s.ephemeral);
  const peers = useChatStore((s) => s.peers);
  const typingPeers = useChatStore((s) => s.typingPeers);
  const inCall = useChatStore((s) => s.inCall);
  const startCall = useChatStore((s) => s.startCall);
  const leave = useChatStore((s) => s.leave);
  const [linkCopied, setLinkCopied] = useState(false);

  async function copyInviteLink() {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(buildShareLink(roomId));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard permission denied or unavailable — nothing to recover.
    }
  }

  const peerList = Object.values(peers);
  const onlineCount = peerList.filter((p) => p.online).length;
  // "alone" gates whether you can send at all — you can still message known
  // members while they're offline, so this is about room membership, not
  // who's currently connected.
  const alone = peerList.length === 0;
  const members = [displayName || 'You', ...peerList.map((p) => p.displayName)].join(', ');
  const typing = typingLabel(typingNames(typingPeers, peers));

  // Full-mesh WebRTC caps how far calls can scale regardless of the much
  // higher text-chat room cap. Video is the binding constraint (each device
  // uploads its own stream to every other participant); voice-only mesh is
  // far lighter and tolerates a much bigger room — so they get separate caps.
  const videoTooMany = onlineCount + 1 > VIDEO_CALL_MAX_PEERS;
  const voiceTooMany = onlineCount + 1 > VOICE_CALL_MAX_PEERS;
  const videoDisabled = onlineCount === 0 || inCall || videoTooMany;
  const voiceDisabled = onlineCount === 0 || inCall || voiceTooMany;
  const videoTitle = videoTooMany ? `Video calls support up to ${VIDEO_CALL_MAX_PEERS} people` : 'Video call';
  const voiceTitle = voiceTooMany ? `Voice calls support up to ${VOICE_CALL_MAX_PEERS} people` : 'Voice call';

  return (
    <header className="flex items-center gap-3 bg-wa-header px-4 py-2.5">
      <RoomAvatar />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-wa-primary">Room {roomId}</span>
          <code className="hidden rounded bg-white/5 px-1.5 text-[11px] text-wa-secondary sm:inline">
            {onlineCount + 1} online
          </code>
          {ephemeral && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-wa-green/15 px-1.5 py-0.5 text-[11px] font-medium text-wa-green"
              title="Nothing about this room is stored server-side — no history, no offline delivery."
            >
              <Flame className="h-3 w-3" /> Temporary
            </span>
          )}
        </div>
        {typing ? (
          <p className="truncate text-xs text-wa-green">{typing}</p>
        ) : (
          <p className="truncate text-xs text-wa-secondary">
            {alone ? 'end-to-end encrypted · waiting for others' : members}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 text-wa-secondary">
        <IconBtn
          onClick={() => void startCall(true)}
          disabled={videoDisabled}
          title={videoTitle}
        >
          <Video className="h-5 w-5" />
        </IconBtn>
        <IconBtn
          onClick={() => void startCall(false)}
          disabled={voiceDisabled}
          title={voiceTitle}
        >
          <Phone className="h-5 w-5" />
        </IconBtn>
        <IconBtn
          onClick={() => void copyInviteLink()}
          title={linkCopied ? 'Link copied' : 'Copy invite link'}
          className="hidden sm:flex"
        >
          {linkCopied ? <Check className="h-5 w-5 text-wa-green" /> : <LinkIcon className="h-5 w-5" />}
        </IconBtn>
        <IconBtn title="Search" className="hidden sm:flex">
          <Search className="h-5 w-5" />
        </IconBtn>
        <IconBtn title="Menu" className="hidden sm:flex">
          <DotsVertical className="h-5 w-5" />
        </IconBtn>
        <IconBtn onClick={leave} title="Leave room" className="md:hidden">
          <Logout className="h-5 w-5" />
        </IconBtn>
      </div>
    </header>
  );
}

function RoomAvatar() {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-wa-input text-wa-secondary">
      <Users className="h-5 w-5" />
    </div>
  );
}

function IconBtn({
  onClick,
  children,
  title,
  disabled,
  className = '',
}: {
  onClick?: () => void;
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/10 hover:text-wa-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent ${className}`}
    >
      {children}
    </button>
  );
}
