import { useEffect, useRef, useState } from 'react';
import { useChatStore, type RosterEntry } from '../store/useChatStore';
import { VIDEO_CALL_MAX_PEERS, type PeerId } from '@private-chat/shared';
import { Avatar } from './Avatar';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Minimize } from './icons';

/** remoteStreams is keyed by the live, ephemeral PeerId; the roster is keyed
 * by permanent public key — resolve a display name by matching peerId. */
function nameForPeerId(peers: Record<string, RosterEntry>, peerId: PeerId): string {
  return Object.values(peers).find((p) => p.peerId === peerId)?.displayName ?? 'Peer';
}

interface CallStageProps {
  elapsed: string;
  /** Shrink down to the compact "return to call" bar. */
  onMinimize: () => void;
}

/**
 * Full-screen WhatsApp-style active call view: one big tile (or a grid for
 * group calls), a top status bar with a minimize action, and a bottom control
 * strip. Rendered instead of the compact CallBar while not minimized.
 */
export function CallStage({ elapsed, onMinimize }: CallStageProps) {
  const inCall = useChatStore((s) => s.inCall);
  const localStream = useChatStore((s) => s.localStream);
  const remoteStreams = useChatStore((s) => s.remoteStreams);
  const displayName = useChatStore((s) => s.displayName);
  const peers = useChatStore((s) => s.peers);
  const micEnabled = useChatStore((s) => s.micEnabled);
  const camEnabled = useChatStore((s) => s.camEnabled);
  const callError = useChatStore((s) => s.callError);
  const toggleMic = useChatStore((s) => s.toggleMic);
  const toggleCam = useChatStore((s) => s.toggleCam);
  const endCall = useChatStore((s) => s.endCall);

  if (!inCall) return null;

  const entries = Object.entries(remoteStreams);
  const soloRemote = entries.length === 1 ? entries[0] : null;
  const you = `${displayName || 'You'} (you)`;
  // A voice-only call can grow past VIDEO_CALL_MAX_PEERS; don't let turning
  // video on at that size silently push a full video mesh onto everyone.
  const videoBlockedBySize = !camEnabled && entries.length + 1 > VIDEO_CALL_MAX_PEERS;
  // Distinguish "no microphone at all" (nothing to toggle) from "muted."
  const hasMicTrack = (localStream?.getAudioTracks().length ?? 0) > 0;

  return (
    <div
      role="dialog"
      aria-label="Ongoing call"
      className="fixed inset-0 z-40 flex animate-pop-in flex-col bg-wa-bg wa-chat-bg"
    >
      {/* Top status bar */}
      <div className="flex items-center gap-3 bg-gradient-to-b from-black/60 to-transparent px-3 pb-6 pt-3 sm:px-4">
        <button
          onClick={onMinimize}
          title="Minimize call"
          aria-label="Minimize call"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white transition hover:bg-black/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green"
        >
          <Minimize className="h-4 w-4" />
        </button>
        <span className="flex items-center gap-2 text-sm font-medium text-white">
          <span className="h-2 w-2 animate-pulse rounded-full bg-wa-green" />
          Ongoing call · <span className="tabular-nums">{elapsed}</span>
        </span>
      </div>

      {/* Video / avatar area */}
      <div className="relative min-h-0 flex-1 px-3 pb-3 sm:px-4">
        {soloRemote ? (
          <div className="relative h-full w-full">
            <VideoTile
              stream={soloRemote[1]}
              label={nameForPeerId(peers, soloRemote[0])}
              big
            />
            <div className="absolute bottom-3 right-3 h-24 w-16 sm:h-36 sm:w-24">
              <VideoTile stream={localStream} label={you} muted mirror micOff={!micEnabled} pip />
            </div>
          </div>
        ) : entries.length === 0 ? (
          <div className="h-full w-full">
            <VideoTile stream={localStream} label={you} muted mirror micOff={!micEnabled} big caption="Calling…" />
          </div>
        ) : (
          <div className="grid h-full grid-cols-2 gap-2 sm:grid-cols-3">
            <VideoTile stream={localStream} label={you} muted mirror micOff={!micEnabled} />
            {entries.map(([peerId, stream]) => (
              <VideoTile key={peerId} stream={stream} label={nameForPeerId(peers, peerId)} />
            ))}
          </div>
        )}
      </div>

      {callError && (
        <p className="px-4 pb-1 text-center text-xs text-red-300">{callError}</p>
      )}

      {/* Bottom controls */}
      <div className="flex items-center justify-center gap-5 bg-gradient-to-t from-black/60 to-transparent px-4 pb-6 pt-4 sm:gap-6">
        <ControlButton
          onClick={toggleMic}
          off={!micEnabled}
          disabled={!hasMicTrack}
          title={!hasMicTrack ? 'No microphone found' : micEnabled ? 'Mute' : 'Unmute'}
        >
          {micEnabled ? <Mic className="h-6 w-6" /> : <MicOff className="h-6 w-6" />}
        </ControlButton>
        <ControlButton
          onClick={() => void toggleCam()}
          off={!camEnabled}
          disabled={videoBlockedBySize}
          title={
            videoBlockedBySize
              ? `Video isn't supported in calls above ${VIDEO_CALL_MAX_PEERS} people`
              : camEnabled
                ? 'Stop video'
                : 'Start video'
          }
        >
          {camEnabled ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
        </ControlButton>
        <button
          onClick={endCall}
          title="Leave call"
          aria-label="Leave call"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition hover:bg-red-400 active:scale-95"
        >
          <PhoneOff className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}

function ControlButton({
  onClick,
  children,
  title,
  off,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  title: string;
  off?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
        off ? 'bg-white/90 text-wa-header' : 'bg-white/15 text-white hover:bg-white/25'
      }`}
    >
      {children}
    </button>
  );
}

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  mirror?: boolean;
  micOff?: boolean;
  /** Fills the container without the rounded/ring "tile" chrome — used for the single big tile. */
  big?: boolean;
  /** Small picture-in-picture styling for the local preview during a 1:1 call. */
  pip?: boolean;
  /** Optional status caption shown under the avatar when there's no video (e.g. "Calling…"). */
  caption?: string;
}

function VideoTile({ stream, label, muted = false, mirror = false, micOff = false, big = false, pip = false, caption }: VideoTileProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = useStreamHasVideo(stream);

  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  return (
    <div
      className={`group relative h-full w-full overflow-hidden bg-black ring-1 ring-wa-border transition ${
        big
          ? 'rounded-none sm:rounded-xl'
          : pip
            ? 'animate-pop-in rounded-lg shadow-xl ring-white/20'
            : 'aspect-video animate-pop-in rounded-xl hover:ring-wa-green/40'
      }`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={`h-full w-full object-cover ${hasVideo ? '' : 'hidden'} ${
          mirror ? '-scale-x-100' : ''
        }`}
      />
      {!hasVideo && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-wa-header to-wa-bg">
          <Avatar name={label} size={pip ? 'sm' : big ? 'lg' : 'md'} />
          {caption && !pip && <p className="text-sm text-wa-secondary">{caption}</p>}
        </div>
      )}
      {!pip && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/75 to-transparent px-2 py-1.5">
          {micOff && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500/90 text-white">
              <MicOff className="h-2.5 w-2.5" />
            </span>
          )}
          <span className="truncate text-xs font-medium text-white">{label}</span>
        </div>
      )}
      {pip && micOff && (
        <span className="absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500/90 text-white">
          <MicOff className="h-2.5 w-2.5" />
        </span>
      )}
    </div>
  );
}

/** True when the stream currently carries at least one live video track. */
function useStreamHasVideo(stream: MediaStream | null): boolean {
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    if (!stream) {
      setHasVideo(false);
      return;
    }
    const update = () => setHasVideo(stream.getVideoTracks().some((t) => t.readyState === 'live'));
    update();
    stream.addEventListener('addtrack', update);
    stream.addEventListener('removetrack', update);
    return () => {
      stream.removeEventListener('addtrack', update);
      stream.removeEventListener('removetrack', update);
    };
  }, [stream]);

  return hasVideo;
}
