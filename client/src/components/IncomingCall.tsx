import { useChatStore } from '../store/useChatStore';
import { Phone, PhoneOff } from './icons';
import { Avatar } from './Avatar';

/**
 * Ringing prompt for an inbound call. Media is only acquired (mic turned on)
 * when the user explicitly Accepts — a peer can never silently open your mic.
 */
export function IncomingCall() {
  const incomingCall = useChatStore((s) => s.incomingCall);
  const peers = useChatStore((s) => s.peers);
  const acceptCall = useChatStore((s) => s.acceptCall);
  const declineCall = useChatStore((s) => s.declineCall);

  if (!incomingCall) return null;
  // incomingCall.from is a live PeerId (call signaling is peerId-based), but
  // the roster is keyed by permanent public key — resolve by matching peerId.
  const caller =
    Object.values(peers).find((p) => p.peerId === incomingCall.from)?.displayName ?? 'Someone';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xs animate-pop-in rounded-2xl bg-wa-panel p-6 text-center shadow-2xl ring-1 ring-wa-border">
        <div className="mx-auto mb-3 w-fit">
          <Avatar name={caller} size="lg" />
        </div>
        <p className="text-sm text-wa-secondary">Incoming call</p>
        <h2 className="mb-6 truncate text-lg font-semibold text-wa-primary">{caller}</h2>
        <div className="flex items-center justify-center gap-6">
          <button
            onClick={declineCall}
            title="Decline"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition hover:bg-red-400"
          >
            <PhoneOff className="h-6 w-6" />
          </button>
          <button
            onClick={() => void acceptCall()}
            title="Accept"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-wa-green text-white shadow-lg transition hover:bg-wa-green-dark"
          >
            <Phone className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
