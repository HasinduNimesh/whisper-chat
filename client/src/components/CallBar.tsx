import { useEffect, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { PhoneOff, Mic, MicOff, Video, VideoOff } from './icons';

/** In-call control strip (rendered only while a call is active). */
export function CallBar() {
  const inCall = useChatStore((s) => s.inCall);
  const micEnabled = useChatStore((s) => s.micEnabled);
  const camEnabled = useChatStore((s) => s.camEnabled);
  const callError = useChatStore((s) => s.callError);
  const toggleMic = useChatStore((s) => s.toggleMic);
  const toggleCam = useChatStore((s) => s.toggleCam);
  const endCall = useChatStore((s) => s.endCall);

  const elapsed = useCallTimer(inCall);
  if (!inCall) return null;

  return (
    <div className="flex flex-col gap-1 bg-wa-green-dark px-4 py-2 text-white">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          Ongoing call · <span className="tabular-nums">{elapsed}</span>
        </span>

        <div className="ml-auto flex items-center gap-2">
          <RoundButton onClick={toggleMic} off={!micEnabled} title={micEnabled ? 'Mute' : 'Unmute'}>
            {micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </RoundButton>
          <RoundButton onClick={() => void toggleCam()} title={camEnabled ? 'Stop video' : 'Start video'}>
            {camEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
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

/** Live mm:ss timer that resets whenever a call starts. */
function useCallTimer(active: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function RoundButton({
  onClick,
  children,
  title,
  off,
}: {
  onClick: () => void;
  children: React.ReactNode;
  title: string;
  off?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
        off ? 'bg-white/90 text-wa-green-dark' : 'bg-white/15 text-white hover:bg-white/25'
      }`}
    >
      {children}
    </button>
  );
}
