import { useEffect } from 'react';
import { useChatStore } from './store/useChatStore';
import { backendOrigin } from './signaling/client';
import { JoinRoom } from './views/JoinRoom';
import { Room } from './views/Room';

// Free-tier hosts (e.g. Render) spin the signaling server down after a period
// of no HTTP traffic. Pinging its health check keeps it warm for as long as
// this tab is open — a real fix for the "first message after idle is slow"
// problem, though it only helps while someone has the app open at all; an
// external uptime monitor is still needed for round-the-clock warmth.
const KEEPALIVE_INTERVAL_MS = 40_000;

function useBackendKeepAlive(): void {
  useEffect(() => {
    const ping = () => {
      fetch(`${backendOrigin()}/healthz`).catch(() => {
        // Best-effort — a failed ping just means we try again next interval.
      });
    };
    ping();
    const id = setInterval(ping, KEEPALIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}

export default function App() {
  useBackendKeepAlive();
  const status = useChatStore((s) => s.status);
  const inRoom = status === 'joined';

  return (
    <div className="h-full w-full">
      {inRoom ? <Room /> : <JoinRoom />}
    </div>
  );
}
