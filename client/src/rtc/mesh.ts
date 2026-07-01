/**
 * WebRTC mesh for small-group calls (2-4 peers). One RTCPeerConnection per
 * remote peer; media flows directly peer-to-peer (DTLS-SRTP), so the signaling
 * server only ever relays SDP/ICE — never audio or video.
 *
 * Negotiation uses the "perfect negotiation" pattern (https://w3.org/TR/webrtc/
 * #perfect-negotiation-example): in every pair exactly one peer is "polite", so
 * simultaneous offers (glare) resolve deterministically without a deadlock.
 */
import type { PeerId, RtcSignal } from '@private-chat/shared';

/**
 * ICE servers: STUN for address discovery, plus TURN relay so calls still
 * connect when peers are behind strict NATs / carrier-grade firewalls (where
 * direct P2P fails). TURN credentials are short-lived and minted by the
 * backend (GET /turn-credentials, see server/src/index.ts) so no long-lived
 * secret ships in the public client bundle. VITE_TURN_* build-time env vars
 * remain as a static fallback for local testing when no backend is reachable.
 */
function staticIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  const turnUrls = (import.meta.env.VITE_TURN_URLS as string | undefined)
    ?.split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (turnUrls && turnUrls.length > 0) {
    servers.push({
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    });
  }
  return servers;
}

/** Origin of the signaling/relay backend, for the /turn-credentials fetch. */
function backendHttpOrigin(): string {
  const signaling = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (signaling) return new URL(signaling.replace(/^ws/, 'http')).origin;
  return location.origin;
}

let iceServersPromise: Promise<RTCIceServer[]> | null = null;

/** Fetch short-lived TURN creds from the backend once per page load, with a
 * STUN(+static TURN)-only fallback if the backend is unreachable. */
function getIceServers(): Promise<RTCIceServer[]> {
  if (!iceServersPromise) {
    iceServersPromise = fetch(`${backendHttpOrigin()}/turn-credentials`)
      .then((res) => (res.ok ? (res.json() as Promise<{ iceServers?: RTCIceServer[] }>) : { iceServers: [] }))
      .then(({ iceServers }) =>
        iceServers && iceServers.length > 0
          ? [staticIceServers()[0], ...iceServers]
          : staticIceServers(),
      )
      .catch(() => staticIceServers());
  }
  return iceServersPromise;
}

export interface MeshCallbacks {
  /** Relay an RTC signal to one peer through the signaling server. */
  sendSignal: (to: PeerId, signal: RtcSignal) => void;
  /** A remote peer's media stream is available (or gained a track). */
  onRemoteStream: (peerId: PeerId, stream: MediaStream) => void;
  /** A peer's connection ended (hang-up, failure, or left the room). */
  onPeerGone: (peerId: PeerId) => void;
}

/**
 * Deterministic, symmetric tie-breaker: exactly one side of every pair is
 * polite. The polite peer yields on an offer collision; the impolite one
 * ignores the incoming offer and keeps its own.
 */
export function isPolite(selfId: PeerId, peerId: PeerId): boolean {
  return selfId < peerId;
}

interface PeerConn {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
}

export class CallMesh {
  private readonly selfId: PeerId;
  private readonly cb: MeshCallbacks;
  private readonly conns = new Map<PeerId, PeerConn>();
  /** Local tracks to (re)attach to every peer connection, with their stream. */
  private localTracks: { track: MediaStreamTrack; stream: MediaStream }[] = [];
  /** Best ICE servers known so far; upgraded once the TURN fetch resolves. */
  private iceServers: RTCIceServer[] = staticIceServers();

  constructor(selfId: PeerId, cb: MeshCallbacks) {
    this.selfId = selfId;
    this.cb = cb;
    // Kick off the TURN credential fetch immediately (well before any call
    // starts) so `ensure()` below can stay synchronous.
    getIceServers().then((servers) => {
      this.iceServers = servers;
    });
  }

  /** Open (or reuse) a connection to a peer and attach current local media. */
  connect(peerId: PeerId): void {
    this.ensure(peerId);
  }

  /** Add a local track and push it to all peers (triggers renegotiation). */
  addLocalTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.localTracks.some((t) => t.track === track)) return;
    this.localTracks.push({ track, stream });
    for (const { pc } of this.conns.values()) {
      if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, stream);
    }
  }

  /** Stop sending a local track to all peers (triggers renegotiation). */
  removeLocalTrack(track: MediaStreamTrack): void {
    this.localTracks = this.localTracks.filter((t) => t.track !== track);
    for (const { pc } of this.conns.values()) {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) pc.removeTrack(sender);
    }
  }

  /** Process an inbound RTC signal relayed from `from`. */
  async handleSignal(from: PeerId, signal: RtcSignal): Promise<void> {
    if (signal.kind === 'bye') {
      this.drop(from);
      return;
    }
    // An inbound offer from an unknown peer means we're being called: spin up
    // a connection so we can answer (and start receiving their media).
    const conn = this.ensure(from);
    const { pc } = conn;

    try {
      if (signal.kind === 'offer' || signal.kind === 'answer') {
        const description: RTCSessionDescriptionInit =
          signal.kind === 'offer'
            ? { type: 'offer', sdp: signal.sdp }
            : { type: 'answer', sdp: signal.sdp };

        const readyForOffer =
          !conn.makingOffer &&
          (pc.signalingState === 'stable' || conn.isSettingRemoteAnswerPending);
        const offerCollision = description.type === 'offer' && !readyForOffer;

        conn.ignoreOffer = !conn.polite && offerCollision;
        if (conn.ignoreOffer) return;

        conn.isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);
        conn.isSettingRemoteAnswerPending = false;

        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.cb.sendSignal(from, { kind: 'answer', sdp: pc.localDescription!.sdp });
        }
      } else {
        // ICE candidate.
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (err) {
          if (!conn.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn(`[rtc] signal from ${from} failed`, err);
    }
  }

  /** Notify a peer we're hanging up, then tear down that connection. */
  hangup(peerId: PeerId): void {
    this.cb.sendSignal(peerId, { kind: 'bye' });
    this.drop(peerId);
  }

  /** Tear down every connection and tell all peers we've left the call. */
  close(): void {
    for (const peerId of [...this.conns.keys()]) {
      this.cb.sendSignal(peerId, { kind: 'bye' });
      this.drop(peerId);
    }
    this.localTracks = [];
  }

  private ensure(peerId: PeerId): PeerConn {
    const existing = this.conns.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const conn: PeerConn = {
      pc,
      remoteStream: new MediaStream(),
      polite: isPolite(this.selfId, peerId),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
    };
    this.conns.set(peerId, conn);

    pc.onnegotiationneeded = async () => {
      try {
        conn.makingOffer = true;
        await pc.setLocalDescription();
        this.cb.sendSignal(peerId, { kind: 'offer', sdp: pc.localDescription!.sdp });
      } catch (err) {
        console.warn(`[rtc] negotiation with ${peerId} failed`, err);
      } finally {
        conn.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.cb.sendSignal(peerId, { kind: 'ice', candidate: candidate.toJSON() });
    };

    pc.ontrack = ({ track, streams }) => {
      // Prefer the remote-provided stream; fall back to our per-peer stream.
      const stream = streams[0] ?? conn.remoteStream;
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      conn.remoteStream = stream;
      this.cb.onRemoteStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.drop(peerId);
      }
    };

    // Attach whatever local media we already have; this fires onnegotiationneeded.
    for (const { track, stream } of this.localTracks) pc.addTrack(track, stream);

    return conn;
  }

  private drop(peerId: PeerId): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    this.conns.delete(peerId);
    conn.pc.onnegotiationneeded = null;
    conn.pc.onicecandidate = null;
    conn.pc.ontrack = null;
    conn.pc.onconnectionstatechange = null;
    try {
      conn.pc.close();
    } catch {
      /* already closed */
    }
    this.cb.onPeerGone(peerId);
  }
}
