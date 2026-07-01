/**
 * Central app state: connection lifecycle, room roster, and the encrypted
 * message log. Owns the SignalingClient and performs all seal/open operations
 * so plaintext never touches the wire or the server.
 */
import { create } from 'zustand';
import type {
  PeerId,
  ServerMessage,
  ChatPayload,
  TextPayload,
  TypingPayload,
  IceServerLike,
  RtcSignal,
} from '@private-chat/shared';
import { VIDEO_CALL_MAX_PEERS } from '@private-chat/shared';
import {
  initCrypto,
  loadOrCreateIdentity,
  sealTo,
  openFrom,
  toB64,
  fromB64,
  type Identity,
} from '../crypto';
import { pinAndCheck, isVerified, setVerified, repin } from '../crypto/trust';
import { SignalingClient, signalingUrl } from '../signaling/client';
import { CallMesh } from '../rtc/mesh';

export type ConnectionStatus = 'idle' | 'connecting' | 'joined' | 'error';

export interface ChatMessage {
  id: string;
  fromPeerId: string;
  fromName: string;
  mine: boolean;
  text: string;
  sentAt: number;
}

/**
 * A room member, keyed by their permanent public key (not the ephemeral,
 * per-session PeerId a live connection gets). `online`/`peerId` reflect
 * whether they're currently connected — a message can still be addressed
 * (and will be persisted server-side) to an offline member.
 */
export interface RosterEntry {
  publicKey: string;
  displayName: string;
  online: boolean;
  /** Only set while `online` — needed for WebRTC call signaling. */
  peerId?: PeerId;
}

interface ChatState {
  status: ConnectionStatus;
  errorText: string | null;
  roomId: string | null;
  selfId: string | null;
  displayName: string;
  identity: Identity | null;
  peers: Record<string, RosterEntry>; // publicKey -> roster entry
  messages: ChatMessage[];
  typingPeers: Record<string, boolean>; // peerId -> currently typing

  // --- Key verification (anti-MITM) state ---
  verifiedPeers: Record<string, boolean>; // peerId -> user-verified safety number
  keyAlerts: Record<string, boolean>; // peerId -> key changed vs. pinned (possible MITM)

  // --- Call (WebRTC mesh) state ---
  incomingCall: { from: string } | null; // a peer is calling; awaiting accept/decline
  inCall: boolean;
  micEnabled: boolean;
  camEnabled: boolean;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>; // peerId -> their media
  callError: string | null;

  /** Load (or create) the local identity without joining a room — e.g. so a
   * "share my contact code" UI has a public key before you've ever joined. */
  ensureIdentity: () => Promise<Identity>;
  join: (roomId: string, displayName: string) => Promise<void>;
  sendText: (text: string) => void;
  sendTyping: (isTyping: boolean) => void;
  leave: () => void;
  verifyPeer: (publicKey: string) => void;

  startCall: (withVideo: boolean) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  toggleMic: () => void;
  toggleCam: () => Promise<void>;
  endCall: () => void;
  dismissCallError: () => void;
}

let client: SignalingClient | null = null;
let mesh: CallMesh | null = null;

/**
 * Signals from a still-ringing caller (offer + any trickled ICE), held until
 * the user actually Accepts. We deliberately do NOT create the RTCPeerConnection
 * or answer the offer while ringing — some browsers won't correctly upgrade an
 * already-negotiated recvonly connection to send media once local tracks are
 * added later, leaving that one leg silently one-directional. Answering only
 * after local media exists avoids the whole class of bug.
 */
const pendingCallSignals = new Map<PeerId, RtcSignal[]>();

/** Auto-clear a peer's typing flag if no refresh arrives (in case 'false' is lost). */
const TYPING_STALE_MS = 5000;
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

type SetState = (
  partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>),
) => void;

export const useChatStore = create<ChatState>((set, get) => ({
  status: 'idle',
  errorText: null,
  roomId: null,
  selfId: null,
  displayName: '',
  identity: null,
  peers: {},
  messages: [],
  typingPeers: {},
  verifiedPeers: {},
  keyAlerts: {},

  incomingCall: null,
  inCall: false,
  micEnabled: false,
  camEnabled: false,
  localStream: null,
  remoteStreams: {},
  callError: null,

  ensureIdentity: async () => {
    const existing = get().identity;
    if (existing) return existing;
    await initCrypto();
    const identity = loadOrCreateIdentity();
    set({ identity });
    return identity;
  },

  join: async (roomId, displayName) => {
    set({ status: 'connecting', errorText: null, displayName });
    const identity = await get().ensureIdentity();

    client = new SignalingClient(signalingUrl(), {
      onMessage: (msg) => handleServerMessage(msg, set, get),
      onOpen: () => {
        client?.send({
          type: 'join',
          roomId,
          publicKey: toB64(identity.publicKey),
          displayName,
        });
      },
      onClose: () => {
        if (get().status === 'joined') {
          set({ status: 'error', errorText: 'Disconnected from server' });
        }
      },
      onError: () => set({ status: 'error', errorText: 'Connection error' }),
    });
    client.connect();
  },

  sendText: (text) => {
    const { identity, peers, selfId, displayName } = get();
    if (!identity || !selfId || !client) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const payload: ChatPayload = { kind: 'text', text: trimmed, sentAt: Date.now() };
    const serialized = JSON.stringify(payload);

    // Encrypt and relay separately to every known member — online or not,
    // addressed by their permanent public key (peers state is never keyed
    // by the ephemeral PeerId). The server live-delivers if they're
    // connected and always persists, so this is what makes offline
    // delivery and history work.
    for (const peer of Object.values(peers)) {
      const sealed = sealTo(serialized, fromB64(peer.publicKey), identity.privateKey);
      client.send({
        type: 'relay',
        to: peer.publicKey,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        persist: true,
      });
    }
    // Also seal a copy to ourselves, purely so this message is persisted and
    // recoverable later (reload, or another device sharing this identity).
    // The server never live-delivers a self-addressed message back to us.
    const selfSealed = sealTo(serialized, identity.publicKey, identity.privateKey);
    client.send({
      type: 'relay',
      to: toB64(identity.publicKey),
      ciphertext: selfSealed.ciphertext,
      nonce: selfSealed.nonce,
      persist: true,
    });

    // Echo into our own log immediately.
    set((st) => ({
      messages: [
        ...st.messages,
        {
          id: crypto.randomUUID(),
          fromPeerId: toB64(identity.publicKey),
          fromName: displayName,
          mine: true,
          text: trimmed,
          sentAt: payload.sentAt,
        },
      ],
    }));
  },

  sendTyping: (isTyping) => {
    const { identity, peers, selfId } = get();
    if (!identity || !selfId || !client) return;

    const payload: ChatPayload = { kind: 'typing', typing: isTyping, sentAt: Date.now() };
    const serialized = JSON.stringify(payload);

    // Only online members can usefully receive a live typing indicator; no
    // point sealing/sending it to someone who isn't connected, and it's
    // explicitly not persisted (ephemeral, unlike a real message).
    for (const peer of Object.values(peers).filter((p) => p.online)) {
      const sealed = sealTo(serialized, fromB64(peer.publicKey), identity.privateKey);
      client.send({
        type: 'relay',
        to: peer.publicKey,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
      });
    }
  },

  leave: () => {
    teardownCall(set);
    mesh = null;
    for (const t of typingTimers.values()) clearTimeout(t);
    typingTimers.clear();
    client?.send({ type: 'leave' });
    client?.close();
    client = null;
    set({
      status: 'idle',
      roomId: null,
      selfId: null,
      peers: {},
      messages: [],
      typingPeers: {},
      verifiedPeers: {},
      keyAlerts: {},
      incomingCall: null,
      errorText: null,
    });
  },

  /** Mark a peer's key trusted after the user compared the safety number. */
  verifyPeer: (publicKey) => {
    const { peers, roomId, keyAlerts } = get();
    const peer = peers[publicKey];
    if (!peer || !roomId) return;
    // If this was a changed/mismatched key, accept it as the new pin.
    if (keyAlerts[publicKey]) repin(roomId, peer.displayName, peer.publicKey);
    setVerified(peer.publicKey, true);
    set((st) => ({
      verifiedPeers: { ...st.verifiedPeers, [publicKey]: true },
      keyAlerts: { ...st.keyAlerts, [publicKey]: false },
    }));
  },

  startCall: async (withVideo) => {
    // Defense in depth: the UI already disables the video-call button once
    // the room's too big, but don't rely solely on that.
    if (withVideo) {
      const onlineCount = Object.values(get().peers).filter((p) => p.online).length;
      if (onlineCount + 1 > VIDEO_CALL_MAX_PEERS) {
        set({ callError: `Video isn't supported in calls above ${VIDEO_CALL_MAX_PEERS} people.` });
        return;
      }
    }
    try {
      await enterCall(withVideo, set, get);
    } catch (err) {
      set({ callError: mediaErrorText(err) });
    }
  },

  /** Accept a ringing incoming call: NOW acquire the mic and join the mesh. */
  acceptCall: async () => {
    const ic = get().incomingCall;
    if (!ic) return;
    set({ incomingCall: null });
    try {
      // Acquire media and connect to every other peer first; the caller's
      // own connection is deferred so we can answer their buffered offer
      // below with local tracks already attached (sendrecv from the start).
      await enterCall(false, set, get, ic.from);
      const queued = pendingCallSignals.get(ic.from) ?? [];
      pendingCallSignals.delete(ic.from);
      for (const signal of queued) {
        await mesh?.handleSignal(ic.from, signal);
      }
    } catch (err) {
      set({ callError: mediaErrorText(err) });
    }
  },

  /** Decline a ringing call: tell the caller we're not answering, keep the mic off. */
  declineCall: () => {
    const ic = get().incomingCall;
    if (!ic) return;
    set({ incomingCall: null });
    pendingCallSignals.delete(ic.from);
    mesh?.hangup(ic.from);
  },

  toggleMic: () => {
    const { localStream, micEnabled } = get();
    const audio = localStream?.getAudioTracks()[0];
    if (!audio) return;
    audio.enabled = !micEnabled;
    set({ micEnabled: !micEnabled });
  },

  toggleCam: async () => {
    const { localStream, camEnabled, peers } = get();
    if (!localStream || !mesh) return;
    if (camEnabled) {
      const track = localStream.getVideoTracks()[0];
      if (track) {
        mesh.removeLocalTrack(track);
        track.stop();
        localStream.removeTrack(track);
      }
      set({ camEnabled: false });
    } else {
      // A voice-only call can grow past VIDEO_CALL_MAX_PEERS (that's the
      // whole point of the higher voice cap) — don't let turning video on
      // mid-call silently push a full video mesh onto everyone at that size.
      const onlineCount = Object.values(peers).filter((p) => p.online).length;
      if (onlineCount + 1 > VIDEO_CALL_MAX_PEERS) {
        set({ callError: `Video isn't supported in calls above ${VIDEO_CALL_MAX_PEERS} people.` });
        return;
      }
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = cam.getVideoTracks()[0];
        localStream.addTrack(track);
        mesh.addLocalTrack(track, localStream);
        set({ camEnabled: true, callError: null });
      } catch (err) {
        set({ callError: mediaErrorText(err) });
      }
    }
  },

  endCall: () => {
    mesh?.close();
    teardownCall(set);
  },

  dismissCallError: () => set({ callError: null }),
}));

/**
 * Acquire local media, join the mesh call, and offer media to every peer.
 * `deferPeer`, if given, is skipped here — the caller will instead replay
 * that peer's buffered offer (see acceptCall) once local tracks already
 * exist, so the very first answer we send them is sendrecv, not recvonly.
 */
/** True for the "no device of this kind exists" family of getUserMedia errors. */
function isNoDeviceError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
}

/**
 * Acquire call media, falling back to whatever's actually available instead
 * of failing the whole call when just one device type is missing — e.g. a
 * desktop with a working camera but no microphone the OS recognizes at all.
 * Requesting {audio:true, video:true} fails outright if EITHER is absent,
 * even though the other might work fine; retry with just the piece that
 * failed dropped, in both directions, before giving up entirely.
 */
async function acquireCallMedia(withVideo: boolean): Promise<{ stream: MediaStream; degraded: string | null }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    return { stream, degraded: null };
  } catch (err) {
    if (!isNoDeviceError(err)) throw err; // permission denied etc. — nothing to gracefully degrade to
    if (withVideo) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        return { stream, degraded: "No microphone found — joined with video only, they won't hear you." };
      } catch (videoOnlyErr) {
        if (!isNoDeviceError(videoOnlyErr)) throw videoOnlyErr;
        // Camera itself must be the missing piece — fall back to audio-only.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        return { stream, degraded: 'No camera found — joined with audio only.' };
      }
    }
    throw err; // voice call with no mic — nothing sensible to fall back to
  }
}

async function enterCall(
  withVideo: boolean,
  set: SetState,
  get: () => ChatState,
  deferPeer?: PeerId,
): Promise<void> {
  const { selfId, peers, localStream } = get();
  if (!selfId || !mesh) return;
  if (localStream) return; // already in a call

  const { stream, degraded } = await acquireCallMedia(withVideo);
  set({
    inCall: true,
    micEnabled: stream.getAudioTracks().length > 0,
    camEnabled: stream.getVideoTracks().length > 0,
    localStream: stream,
    callError: degraded,
  });
  for (const track of stream.getTracks()) mesh.addLocalTrack(track, stream);
  // We already hold idle connections to every ONLINE peer; adding tracks
  // renegotiates. Offline members have no live PeerId to connect to at all.
  for (const peer of Object.values(peers)) {
    if (peer.online && peer.peerId && peer.peerId !== deferPeer) mesh.connect(peer.peerId);
  }
}

/** Stop local media and clear all call state (does not close the mesh). */
function teardownCall(set: SetState): void {
  const stream = useChatStore.getState().localStream;
  stream?.getTracks().forEach((t) => t.stop());
  set({
    inCall: false,
    micEnabled: false,
    camEnabled: false,
    localStream: null,
    remoteStreams: {},
    incomingCall: null,
    callError: null,
  });
}

/* ---- decrypted-payload validation (a peer could seal a malformed blob) ---- */

const MAX_TEXT_LEN = 8192;

function isTextPayload(p: unknown): p is TextPayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    (p as { kind?: unknown }).kind === 'text' &&
    typeof (p as { text?: unknown }).text === 'string' &&
    (p as { text: string }).text.length <= MAX_TEXT_LEN &&
    Number.isFinite((p as { sentAt?: unknown }).sentAt)
  );
}

function isTypingPayload(p: unknown): p is TypingPayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    (p as { kind?: unknown }).kind === 'typing' &&
    typeof (p as { typing?: unknown }).typing === 'boolean'
  );
}

/** Build a CallMesh whose signals/streams are bridged into the store. */
function createMesh(selfId: PeerId, iceServers: IceServerLike[], set: SetState): CallMesh {
  return new CallMesh(selfId, iceServers, {
    sendSignal: (to, signal) => client?.send({ type: 'signal', to, signal }),
    onRemoteStream: (peerId, stream) =>
      set((st) => ({ remoteStreams: { ...st.remoteStreams, [peerId]: stream } })),
    onPeerGone: (peerId) =>
      set((st) => {
        if (!st.remoteStreams[peerId]) return {};
        const streams = { ...st.remoteStreams };
        delete streams[peerId];
        return { remoteStreams: streams };
      }),
  });
}

/** Mark a peer as typing (with a stale-timeout) or clear it. */
function setTypingPeer(peerId: string, typing: boolean, set: SetState): void {
  const existing = typingTimers.get(peerId);
  if (existing) clearTimeout(existing);

  if (!typing) {
    clearTypingPeer(peerId, set);
    return;
  }
  set((st) =>
    st.typingPeers[peerId] ? {} : { typingPeers: { ...st.typingPeers, [peerId]: true } },
  );
  typingTimers.set(
    peerId,
    setTimeout(() => clearTypingPeer(peerId, set), TYPING_STALE_MS),
  );
}

function clearTypingPeer(peerId: string, set: SetState): void {
  const existing = typingTimers.get(peerId);
  if (existing) {
    clearTimeout(existing);
    typingTimers.delete(peerId);
  }
  set((st) => {
    if (!st.typingPeers[peerId]) return {};
    const next = { ...st.typingPeers };
    delete next[peerId];
    return { typingPeers: next };
  });
}

/**
 * Record a peer's advertised key against the local TOFU pin and return the
 * resulting trust flags. `alert` means the key differs from a previously pinned
 * one for the same (room, name) — a possible server-side key swap / MITM.
 */
function ingestPeerKey(
  roomId: string,
  peer: { publicKey: string; displayName: string },
): { verified: boolean; alert: boolean } {
  const result = pinAndCheck(roomId, peer.displayName, peer.publicKey);
  const alert = result === 'changed';
  return { verified: !alert && isVerified(peer.publicKey), alert };
}

function mediaErrorText(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone/camera permission denied.';
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') {
    return 'No microphone or camera found.';
  }
  return 'Could not start the call.';
}

function handleServerMessage(
  msg: ServerMessage,
  set: SetState,
  get: () => ChatState,
): void {
  switch (msg.type) {
    case 'joined': {
      const peers: Record<string, RosterEntry> = {};
      const verifiedPeers: Record<string, boolean> = {};
      const keyAlerts: Record<string, boolean> = {};
      for (const m of msg.members) {
        peers[m.publicKey] = { publicKey: m.publicKey, displayName: m.displayName, online: m.online, peerId: m.peerId };
        const trust = ingestPeerKey(msg.roomId, m);
        verifiedPeers[m.publicKey] = trust.verified;
        keyAlerts[m.publicKey] = trust.alert;
      }

      // Decrypt any history addressed to us (offline messages + our own past
      // sends), oldest first, and seed the message log with it.
      const identity = get().identity;
      const selfPublicKey = identity ? toB64(identity.publicKey) : '';
      const messages: ChatMessage[] = [];
      if (identity) {
        for (const entry of msg.history) {
          try {
            const plain = openFrom(
              { ciphertext: entry.ciphertext, nonce: entry.nonce },
              fromB64(entry.fromPublicKey),
              identity.privateKey,
            );
            const payload: unknown = JSON.parse(plain);
            if (!isTextPayload(payload)) continue;
            messages.push({
              id: crypto.randomUUID(),
              fromPeerId: entry.fromPublicKey,
              fromName: entry.fromDisplayName,
              mine: entry.fromPublicKey === selfPublicKey,
              text: payload.text,
              sentAt: payload.sentAt,
            });
          } catch {
            // Tampered/undecryptable — drop silently, same as a live message.
          }
        }
        messages.sort((a, b) => a.sentAt - b.sentAt);
      }

      set({ status: 'joined', roomId: msg.roomId, selfId: msg.selfId, peers, verifiedPeers, keyAlerts, messages });
      // Stand up the call mesh and hold idle connections to everyone already
      // online, so any later call (or inbound offer) negotiates instantly.
      mesh = createMesh(msg.selfId, msg.iceServers, set);
      for (const peer of Object.values(peers)) {
        if (peer.online && peer.peerId) mesh.connect(peer.peerId);
      }
      break;
    }
    case 'peer-joined': {
      const trust = ingestPeerKey(get().roomId ?? '', msg.peer);
      set((st) => ({
        peers: {
          ...st.peers,
          [msg.peer.publicKey]: {
            publicKey: msg.peer.publicKey,
            displayName: msg.peer.displayName,
            online: true,
            peerId: msg.peer.peerId,
          },
        },
        verifiedPeers: { ...st.verifiedPeers, [msg.peer.publicKey]: trust.verified },
        keyAlerts: { ...st.keyAlerts, [msg.peer.publicKey]: trust.alert },
      }));
      mesh?.connect(msg.peer.peerId);
      break;
    }
    case 'peer-left': {
      mesh?.handleSignal(msg.peerId, { kind: 'bye' });
      // typingPeers/verifiedPeers/keyAlerts are keyed by public key, but this
      // event only carries the now-defunct ephemeral PeerId — resolve it.
      const entry = Object.values(get().peers).find((p) => p.peerId === msg.peerId);
      if (entry) clearTypingPeer(entry.publicKey, set);
      set((st) => {
        const streams = { ...st.remoteStreams };
        delete streams[msg.peerId];
        // Flip offline, don't delete — they're still a known room member and
        // can still be messaged; trust state (verified/alert) also survives.
        const peers = entry
          ? { ...st.peers, [entry.publicKey]: { ...entry, online: false, peerId: undefined } }
          : st.peers;
        return {
          peers,
          remoteStreams: streams,
          // Dismiss a ringing prompt if the caller left.
          incomingCall: st.incomingCall?.from === msg.peerId ? null : st.incomingCall,
        };
      });
      break;
    }
    case 'deliver': {
      const { identity, peers } = get();
      const sender = peers[msg.from];
      if (!identity || !sender) return;
      try {
        const plain = openFrom(
          { ciphertext: msg.ciphertext, nonce: msg.nonce },
          fromB64(sender.publicKey),
          identity.privateKey,
        );
        const payload: unknown = JSON.parse(plain);
        if (isTypingPayload(payload)) {
          setTypingPeer(msg.from, payload.typing, set);
          return;
        }
        // Anything that isn't a well-formed text payload is dropped — a malicious
        // peer must not be able to inject a non-string `text` (which would crash
        // React rendering) or an oversized blob.
        if (!isTextPayload(payload)) return;
        // A real message arrived — they've stopped typing.
        clearTypingPeer(msg.from, set);
        set((st) => ({
          messages: [
            ...st.messages,
            {
              id: crypto.randomUUID(),
              fromPeerId: msg.from,
              fromName: sender.displayName,
              mine: false,
              text: payload.text,
              sentAt: payload.sentAt,
            },
          ],
        }));
      } catch {
        // Decryption/auth failure — drop silently (could be tamper or bad key).
      }
      break;
    }
    case 'signal': {
      // A caller withdrawing dismisses any ringing prompt from them.
      if (msg.signal.kind === 'bye') {
        pendingCallSignals.delete(msg.from);
        if (get().incomingCall?.from === msg.from) set({ incomingCall: null });
      }
      const { inCall, incomingCall } = get();
      const ringingFromThisPeer = !inCall && incomingCall?.from === msg.from;
      const isNewIncomingOffer = msg.signal.kind === 'offer' && !inCall && !incomingCall;
      if (ringingFromThisPeer || isNewIncomingOffer) {
        // Buffer instead of answering now: creating the RTCPeerConnection and
        // answering before the user Accepts (i.e. before we have any local
        // media) leaves that connection recvonly on some browsers even after
        // media is added later. Hold the offer (and any trickled ICE) until
        // acceptCall() actually has a mic/camera to answer with.
        if (msg.signal.kind !== 'bye') {
          const q = pendingCallSignals.get(msg.from) ?? [];
          q.push(msg.signal);
          pendingCallSignals.set(msg.from, q);
        }
        if (isNewIncomingOffer) {
          set((st) => (st.incomingCall ? {} : { incomingCall: { from: msg.from } }));
        }
        break;
      }
      void mesh?.handleSignal(msg.from, msg.signal);
      break;
    }
    case 'error': {
      set({ status: 'error', errorText: msg.message });
      break;
    }
  }
}
