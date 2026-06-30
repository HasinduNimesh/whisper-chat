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

  // --- Call (WebRTC mesh) state ---
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

  startCall: (withVideo: boolean) => Promise<void>;
  toggleMic: () => void;
  toggleCam: () => Promise<void>;
  endCall: () => void;
}

let client: SignalingClient | null = null;
let mesh: CallMesh | null = null;
/** Guards against firing multiple auto-joins for simultaneous inbound offers. */
let autoJoining = false;

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
      errorText: null,
    });
  },

  startCall: async (withVideo) => {
    try {
      await enterCall(withVideo, set, get);
    } catch (err) {
      set({ callError: mediaErrorText(err) });
    }
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
    callError: null,
  });
}

/** Build a CallMesh whose signals/streams are bridged into the store. */
function createMesh(selfId: PeerId, set: SetState): CallMesh {
  return new CallMesh(selfId, {
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
      for (const p of msg.peers) peers[p.peerId] = p;
      set({ status: 'joined', roomId: msg.roomId, selfId: msg.selfId, peers });
      // Stand up the call mesh and hold idle connections to everyone already
      // here, so any later call (or inbound offer) negotiates instantly.
      mesh = createMesh(msg.selfId, set);
      for (const peerId of Object.keys(peers)) mesh.connect(peerId);
      break;
    }
    case 'peer-joined': {
      set((st) => ({ peers: { ...st.peers, [msg.peer.peerId]: msg.peer } }));
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
        return { peers: next, remoteStreams: streams };
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
        const payload = JSON.parse(plain) as ChatPayload;
        if (payload.kind === 'typing') {
          setTypingPeer(msg.from, payload.typing, set);
          return;
        }
        if (payload.kind !== 'text') return;
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
      void mesh?.handleSignal(msg.from, msg.signal);
      // An inbound offer while we're not in a call is an incoming call: join
      // (acquire mic) so we can talk back, not just receive their audio/video.
      if (msg.signal.kind === 'offer' && !get().inCall && !autoJoining) {
        autoJoining = true;
        void enterCall(false, set, get)
          .catch((err) => set({ callError: mediaErrorText(err) }))
          .finally(() => {
            autoJoining = false;
          });
      }
      break;
    }
    case 'error': {
      set({ status: 'error', errorText: msg.message });
      break;
    }
  }
}
