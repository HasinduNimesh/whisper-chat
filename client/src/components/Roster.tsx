import { useChatStore } from '../store/useChatStore';
import { Avatar } from './Avatar';
import { Phone } from './icons';

/** Participant list for the active room, with presence + in-call status. */
export function Roster() {
  const displayName = useChatStore((s) => s.displayName);
  const peers = useChatStore((s) => s.peers);
  const remoteStreams = useChatStore((s) => s.remoteStreams);
  const inCall = useChatStore((s) => s.inCall);
  const peerList = Object.values(peers);

  return (
    <div>
      <h2 className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-wa-green">
        Participants · {peerList.length + 1}
      </h2>
      <ul>
        <PersonRow name={displayName || 'You'} you inCall={inCall} />
        {peerList.map((p) => (
          <PersonRow key={p.peerId} name={p.displayName} inCall={!!remoteStreams[p.peerId]} />
        ))}
      </ul>
    </div>
  );
}

function PersonRow({ name, you = false, inCall = false }: { name: string; you?: boolean; inCall?: boolean }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2 transition hover:bg-wa-hover">
      <Avatar name={name} size="md" online />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-wa-primary">{name}</span>
          {you && <span className="text-[11px] text-wa-secondary">You</span>}
        </div>
        <span className="text-xs text-wa-secondary">{inCall ? 'in call' : 'online'}</span>
      </div>
      {inCall && (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-wa-green/15 text-wa-green">
          <Phone className="h-3.5 w-3.5" />
        </span>
      )}
    </li>
  );
}
