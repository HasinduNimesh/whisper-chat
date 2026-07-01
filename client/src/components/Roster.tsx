import { useMemo, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { safetyNumber, fromB64 } from '../crypto';
import type { PeerIdentity } from '@private-chat/shared';
import { Avatar } from './Avatar';
import { Phone, ShieldCheck, ShieldAlert, Shield, ChevronDown } from './icons';

/** Participant list for the active room, with presence + key-verification state. */
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
        <SelfRow name={displayName || 'You'} inCall={inCall} />
        {peerList.map((p) => (
          <PeerRow key={p.peerId} peer={p} inCall={!!remoteStreams[p.peerId]} />
        ))}
      </ul>
    </div>
  );
}

function SelfRow({ name, inCall }: { name: string; inCall: boolean }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <Avatar name={name} size="md" online />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-wa-primary">{name}</span>
          <span className="text-[11px] text-wa-secondary">You</span>
        </div>
        <span className="text-xs text-wa-secondary">{inCall ? 'in call' : 'online'}</span>
      </div>
    </li>
  );
}

/** A remote participant, with an expandable safety-number verification panel. */
function PeerRow({ peer, inCall }: { peer: PeerIdentity; inCall: boolean }) {
  const identity = useChatStore((s) => s.identity);
  const verified = useChatStore((s) => s.verifiedPeers[peer.peerId]);
  const alert = useChatStore((s) => s.keyAlerts[peer.peerId]);
  const verifyPeer = useChatStore((s) => s.verifyPeer);
  const [open, setOpen] = useState(false);

  // Deterministic safety number between us and this peer. Same on both devices
  // iff there is no man-in-the-middle on the key exchange.
  const number = useMemo(() => {
    if (!identity) return '';
    try {
      return safetyNumber(identity.publicKey, fromB64(peer.publicKey));
    } catch {
      return '';
    }
  }, [identity, peer.publicKey]);

  return (
    <li className={alert ? 'bg-red-500/5' : undefined}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-wa-hover"
        aria-expanded={open}
      >
        <Avatar name={peer.displayName} size="md" online />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-wa-primary">{peer.displayName}</span>
            <TrustBadge verified={verified} alert={alert} />
          </div>
          <span className="text-xs text-wa-secondary">
            {alert ? 'security number changed' : verified ? 'verified' : inCall ? 'in call' : 'not verified'}
          </span>
        </div>
        {inCall && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-wa-green/15 text-wa-green">
            <Phone className="h-3.5 w-3.5" />
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-wa-secondary transition ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1">
          {alert && (
            <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-2 text-[11px] text-red-300 ring-1 ring-red-500/20">
              <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                This person&apos;s security number changed since you last saw them. That can happen
                if they reinstalled — but it can also mean someone is intercepting your messages.
                Re-verify below before trusting it.
              </span>
            </p>
          )}
          <p className="mb-1.5 text-[11px] text-wa-secondary">
            Compare this security number with {peer.displayName} over a trusted channel (in person,
            a phone call). If it matches on both devices, no one can read your messages.
          </p>
          <code className="block select-all break-all rounded-lg bg-wa-input px-2.5 py-2 font-mono text-[12px] leading-relaxed tracking-wide text-wa-primary">
            {number || 'unavailable'}
          </code>
          {!verified && (
            <button
              onClick={() => verifyPeer(peer.peerId)}
              className="mt-2 flex items-center gap-1.5 rounded-lg bg-wa-green px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-wa-green-dark"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Mark as verified
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function TrustBadge({ verified, alert }: { verified?: boolean; alert?: boolean }) {
  if (alert) {
    return (
      <span title="Security number changed" className="text-red-400">
        <ShieldAlert className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (verified) {
    return (
      <span title="Verified" className="text-wa-green">
        <ShieldCheck className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span title="Not verified" className="text-wa-secondary">
      <Shield className="h-3.5 w-3.5" />
    </span>
  );
}
