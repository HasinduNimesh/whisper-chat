import { useChatStore } from '../store/useChatStore';
import { PhoneOff, Mic, MicOff, Video, VideoOff, Expand } from './icons';

interface CallBarProps {
  elapsed: string;
  /** Restore the full-screen call view. */
  onExpand: () => void;
}

/**
 * Compact "return to call" strip shown while the full-screen call view is
 * minimized — lets people keep browsing the chat while the call continues.
 */
export function CallBar({ elapsed, onExpand }: CallBarProps) {
  const micEnabled = useChatStore((s) => s.micEnabled);
  const camEnabled = useChatStore((s) => s.camEnabled);
  const localStream = useChatStore((s) => s.localStream);
  const callError = useChatStore((s) => s.callError);
  const toggleMic = useChatStore((s) => s.toggleMic);
  const toggleCam = useChatStore((s) => s.toggleCam);
  const endCall = useChatStore((s) => s.endCall);
  // Distinguish "no microphone at all" (nothing to toggle) from "muted."
  const hasMicTrack = (localStream?.getAudioTracks().length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-1 bg-wa-green-dark px-4 py-2 text-white">
      <div className="flex items-center gap-3">
        <button
          onClick={onExpand}
          title="Return to call"
          aria-label="Return to call"
          className="flex min-w-0 items-center gap-2 rounded-md text-sm font-medium transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white" />
          <span className="truncate">
            Ongoing call · <span className="tabular-nums">{elapsed}</span>
          </span>
        </button>

        <div className="ml-auto flex items-center gap-2">
          <RoundButton
            onClick={toggleMic}
            off={!micEnabled}
            disabled={!hasMicTrack}
            title={!hasMicTrack ? 'No microphone found' : micEnabled ? 'Mute' : 'Unmute'}
          >
            {micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </RoundButton>
          <RoundButton onClick={() => void toggleCam()} title={camEnabled ? 'Stop video' : 'Start video'}>
            {camEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          </RoundButton>
          <RoundButton onClick={onExpand} title="Expand call">
            <Expand className="h-4 w-4" />
          </RoundButton>
          <button
            onClick={endCall}
            title="Leave call"
            className="flex h-8 items-center gap-1.5 rounded-full bg-red-500 px-3 text-xs font-semibold shadow-sm transition hover:bg-red-400"
          >
            <PhoneOff className="h-4 w-4" /> Leave
          </button>
        </div>
      </div>
      {callError && <p className="text-xs text-red-100">{callError}</p>}
    </div>
  );
}

function RoundButton({
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
      className={`flex h-8 w-8 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${
        off ? 'bg-white/90 text-wa-green-dark' : 'bg-white/15 text-white hover:bg-white/25'
      }`}
    >
      {children}
    </button>
  );
}
