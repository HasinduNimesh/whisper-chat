import { useEffect, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { CallStage } from './CallStage';
import { CallBar } from './CallBar';

/**
 * Owns the "minimized vs full-screen" presentation state for the active call
 * and the shared call-duration timer, so switching views never resets the
 * clock. A call always opens full-screen (WhatsApp-style) and can be
 * minimized down to a compact "return to call" bar while browsing the chat.
 */
export function CallOverlay() {
  const inCall = useChatStore((s) => s.inCall);
  const [minimized, setMinimized] = useState(false);
  const elapsed = useCallTimer(inCall);

  // Every new call starts full-screen, even if a previous call was minimized.
  useEffect(() => {
    if (inCall) setMinimized(false);
  }, [inCall]);

  if (!inCall) return null;

  return minimized ? (
    <CallBar elapsed={elapsed} onExpand={() => setMinimized(false)} />
  ) : (
    <CallStage elapsed={elapsed} onMinimize={() => setMinimized(true)} />
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
