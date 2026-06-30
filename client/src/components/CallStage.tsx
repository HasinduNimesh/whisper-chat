import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { Avatar } from './Avatar';
import { MicOff } from './icons';

/** Grid of video/audio tiles for the active call: yourself + each remote peer. */
export function CallStage() {
  const inCall = useChatStore((s) => s.inCall);
  const localStream = useChatStore((s) => s.localStream);
  const remoteStreams = useChatStore((s) => s.remoteStreams);
  const displayName = useChatStore((s) => s.displayName);
  const peers = useChatStore((s) => s.peers);
  const micEnabled = useChatStore((s) => s.micEnabled);

  if (!inCall) return null;

  const entries = Object.entries(remoteStreams);

  return (
    <div className="border-b border-wa-border bg-wa-bg p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <VideoTile
          stream={localStream}
          label={`${displayName || 'You'} (you)`}
          muted
          mirror
          micOff={!micEnabled}
        />
        {entries.map(([peerId, stream]) => (
          <VideoTile key={peerId} stream={stream} label={peers[peerId]?.displayName ?? 'Peer'} />
        ))}
      </div>
    </div>
  );
}

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  mirror?: boolean;
  micOff?: boolean;
}

function VideoTile({ stream, label, muted = false, mirror = false, micOff = false }: VideoTileProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = useStreamHasVideo(stream);

  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  return (
    <div className="group relative aspect-video animate-pop-in overflow-hidden rounded-xl bg-black ring-1 ring-wa-border transition hover:ring-wa-green/40">
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
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-wa-header to-wa-bg">
          <Avatar name={label} size="lg" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/75 to-transparent px-2 py-1.5">
        {micOff && (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500/90 text-white">
            <MicOff className="h-2.5 w-2.5" />
          </span>
        )}
        <span className="truncate text-xs font-medium text-white">{label}</span>
      </div>
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
