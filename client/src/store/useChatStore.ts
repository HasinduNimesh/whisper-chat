/**
 * Central app state: connection lifecycle, room roster, and the encrypted
 * message log. Owns the SignalingClient and performs all seal/open operations
 * so plaintext never touches the wire or the server.
 */
import { create } from 'zustand';
import type {
  PeerId,
  PeerIdentity,
  ServerMessage,
  ChatPayload,
  TextPayload,
  TypingPayload,
  IceServerLike,
} from '@private-chat/shared';
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

interface ChatState {
  status: ConnectionStatus;
  errorText: string | null;
  roomId: string | null;
  selfId: string | null;
  displayName: string;
  identity: Identity | null;
  peers: Record<string, PeerIdentity>; // peerId -> identity
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

  join: (roomId: string, displayName: string) => Promise<void>;
  sendText: (text: string) => void;
  sendTyping: (isTyping: boolean) => void;
  leave: () => void;
  verifyPeer: (peerId: string) => void;

  startCall: (withVideo: boolean) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  toggleMic: () => void;
  toggleCam: () => Promise<void>;
  endCall: () => void;
}

let client: SignalingClient | null = null;
let mesh: CallMesh | null = null;

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

  join: async (roomId, displayName) => {
    set({ status: 'connecting', errorText: null, displayName });
    await initCrypto();
    const identity = loadOrCreateIdentity();
    set({ identity });

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

    // Encrypt and relay separately to each peer (per-recipient sealed box).
    for (const peer of Object.values(peers)) {
      const sealed = sealTo(serialized, fromB64(peer.publicKey), identity.privateKey);
      client.send({
        type: 'relay',
        to: peer.peerId,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
      });
    }

    // Echo into our own log immediately.
    set((st) => ({
      messages: [
        ...st.messages,
        {
          id: crypto.randomUUID(),
          fromPeerId: selfId,
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

    // Sealed per-recipient just like a message — the server only sees ciphertext.
    for (const peer of Object.values(peers)) {
      const sealed = sealTo(serialized, fromB64(peer.publicKey), identity.privateKey);
      client.send({
        type: 'relay',
        to: peer.peerId,
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
  verifyPeer: (peerId) => {
    const { peers, roomId, keyAlerts } = get();
    const peer = peers[peerId];
    if (!peer || !roomId) return;
    // If this was a changed/mismatched key, accept it as the new pin.
    if (keyAlerts[peerId]) repin(roomId, peer.displayName, peer.publicKey);
    setVerified(peer.publicKey, true);
    set((st) => ({
      verifiedPeers: { ...st.verifiedPeers, [peerId]: true },
      keyAlerts: { ...st.keyAlerts, [peerId]: false },
    }));
  },

  startCall: async (withVideo) => {
    try {
      await enterCall(withVideo, set, get);
    } catch (err) {
      set({ callError: mediaErrorText(err) });
    }
  },

  /** Accept a ringing incoming call: NOW acquire the mic and join the mesh. */
  acceptCall: async () => {
    if (!get().incomingCall) return;
    set({ incomingCall: null });
    try {
      await enterCall(false, set, get);
    } catch (err) {
      set({ callError: mediaErrorText(err) });
    }
  },

  /** Decline a ringing call: tear down the caller's connection, keep the mic off. */
  declineCall: () => {
    const ic = get().incomingCall;
    if (!ic) return;
    set({ incomingCall: null });
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
    const { localStream, camEnabled } = get();
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
}));

/** Acquire local media, join the mesh call, and offer media to every peer. */
async function enterCall(
  withVideo: boolean,
  set: SetState,
  get: () => ChatState,
): Promise<void> {
  const { selfId, peers, localStream } = get();
  if (!selfId || !mesh) return;
  if (localStream) return; // already in a call

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  set({
    inCall: true,
    micEnabled: true,
    camEnabled: withVideo,
    localStream: stream,
    callError: null,
  });
  for (const track of stream.getTracks()) mesh.addLocalTrack(track, stream);
  // We already hold idle connections to every peer; adding tracks renegotiates.
  for (const peerId of Object.keys(peers)) mesh.connect(peerId);
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
  peer: PeerIdentity,
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
      const peers: Record<string, PeerIdentity> = {};
      const verifiedPeers: Record<string, boolean> = {};
      const keyAlerts: Record<string, boolean> = {};
      for (const p of msg.peers) {
        peers[p.peerId] = p;
        const trust = ingestPeerKey(msg.roomId, p);
        verifiedPeers[p.peerId] = trust.verified;
        keyAlerts[p.peerId] = trust.alert;
      }
      set({ status: 'joined', roomId: msg.roomId, selfId: msg.selfId, peers, verifiedPeers, keyAlerts });
      // Stand up the call mesh and hold idle connections to everyone already
      // here, so any later call (or inbound offer) negotiates instantly.
      mesh = createMesh(msg.selfId, msg.iceServers, set);
      for (const peerId of Object.keys(peers)) mesh.connect(peerId);
      break;
    }
    case 'peer-joined': {
      const trust = ingestPeerKey(get().roomId ?? '', msg.peer);
      set((st) => ({
        peers: { ...st.peers, [msg.peer.peerId]: msg.peer },
        verifiedPeers: { ...st.verifiedPeers, [msg.peer.peerId]: trust.verified },
        keyAlerts: { ...st.keyAlerts, [msg.peer.peerId]: trust.alert },
      }));
      mesh?.connect(msg.peer.peerId);
      break;
    }
    case 'peer-left': {
      mesh?.handleSignal(msg.peerId, { kind: 'bye' });
      clearTypingPeer(msg.peerId, set);
      set((st) => {
        const next = { ...st.peers };
        delete next[msg.peerId];
        const streams = { ...st.remoteStreams };
        delete streams[msg.peerId];
        const verified = { ...st.verifiedPeers };
        delete verified[msg.peerId];
        const alerts = { ...st.keyAlerts };
        delete alerts[msg.peerId];
        return {
          peers: next,
          remoteStreams: streams,
          verifiedPeers: verified,
          keyAlerts: alerts,
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
      if (msg.signal.kind === 'bye' && get().incomingCall?.from === msg.from) {
        set({ incomingCall: null });
      }
      void mesh?.handleSignal(msg.from, msg.signal);
      // An inbound offer while we're not in a call is an INCOMING CALL. Do not
      // silently acquire the microphone — that would let any room member turn
      // on the victim's mic. Prompt instead; media is neither played (CallStage
      // is gated on inCall) nor sent until the user explicitly accepts.
      if (msg.signal.kind === 'offer' && !get().inCall) {
        set((st) => (st.incomingCall ? {} : { incomingCall: { from: msg.from } }));
      }
      break;
    }
    case 'error': {
      set({ status: 'error', errorText: msg.message });
      break;
    }
  }
}
