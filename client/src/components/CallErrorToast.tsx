import { useEffect } from 'react';
import { useChatStore } from '../store/useChatStore';
import { ShieldAlert } from './icons';

const AUTO_DISMISS_MS = 6000;

/**
 * Surfaces a call failure (permission denied, no camera/mic found, device
 * busy, etc.) that happens BEFORE a call is ever entered. CallStage/CallBar
 * already show `callError` while `inCall` is true, but the full-screen call
 * UI (CallOverlay) is gated entirely on `inCall` — so a failure that occurs
 * while just trying to start a call (the common case: enterCall() throws
 * before ever setting inCall) was previously caught and stored, but never
 * actually shown to the user. This renders regardless of call state,
 * whenever there isn't already an in-call banner covering the same error.
 */
export function CallErrorToast() {
  const callError = useChatStore((s) => s.callError);
  const inCall = useChatStore((s) => s.inCall);
  const dismissCallError = useChatStore((s) => s.dismissCallError);

  useEffect(() => {
    if (!callError || inCall) return;
    const id = setTimeout(dismissCallError, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [callError, inCall, dismissCallError]);

  if (!callError || inCall) return null;

  return (
    <div className="flex items-start gap-2 bg-red-500/10 px-4 py-2 text-xs text-red-300 ring-1 ring-inset ring-red-500/20">
      <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{callError}</span>
      <button
        onClick={dismissCallError}
        aria-label="Dismiss"
        className="shrink-0 text-red-300/70 hover:text-red-200"
      >
        ×
      </button>
    </div>
  );
}
