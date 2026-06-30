/**
 * Shared protocol types between the client and the signaling/relay server.
 *
 * PRIVACY INVARIANT: The server only ever sees ciphertext and routing metadata
 * (room id, peer ids, public keys, WebRTC SDP/ICE). It never sees message
 * plaintext. Any field carrying user content here is an opaque base64 blob that
 * was sealed client-side with libsodium before transmission.
 */

export const ROOM_MIN_PEERS = 2;
export const ROOM_MAX_PEERS = 4;

/** A peer's stable id for the lifetime of a connection (assigned by server). */
export type PeerId = string;

/** Public identity material a peer advertises so others can encrypt to it. */
export interface PeerIdentity {
  peerId: PeerId;
  /** base64 X25519 public key used for sealed-box / key agreement. */
  publicKey: string;
  /** Human-chosen display name (not authenticated; verify via safety number). */
  displayName: string;
}

/* ------------------------------------------------------------------ */
/* Client -> Server messages                                           */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | JoinRoomMessage
  | LeaveRoomMessage
  | RelayMessage
  | SignalMessage;

/** Ask to join (or create) a room and advertise our public identity. */
export interface JoinRoomMessage {
  type: 'join';
  roomId: string;
  publicKey: string;
  displayName: string;
}

export interface LeaveRoomMessage {
  type: 'leave';
}

/** An encrypted chat payload to be relayed to one or all peers. */
export interface RelayMessage {
  type: 'relay';
  /** Target peer, or 'all' to fan out to every other peer in the room. */
  to: PeerId | 'all';
  /** Opaque base64 ciphertext (XChaCha20-Poly1305). Server never decrypts. */
  ciphertext: string;
  /** base64 nonce for the AEAD. */
  nonce: string;
}

/** WebRTC signaling (SDP offer/answer or ICE candidate) targeted at a peer. */
export interface SignalMessage {
  type: 'signal';
  to: PeerId;
  signal: RtcSignal;
}

/* ------------------------------------------------------------------ */
/* Server -> Client messages                                           */
/* ------------------------------------------------------------------ */

export type ServerMessage =
  | JoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | DeliverMessage
  | SignalDeliverMessage
  | ErrorMessage;

/** Sent to a client right after a successful join. */
export interface JoinedMessage {
  type: 'joined';
  selfId: PeerId;
  roomId: string;
  /** Existing peers already in the room. */
  peers: PeerIdentity[];
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  peer: PeerIdentity;
}

export interface PeerLeftMessage {
  type: 'peer-left';
  peerId: PeerId;
}

/** A relayed encrypted chat payload delivered from another peer. */
export interface DeliverMessage {
  type: 'deliver';
  from: PeerId;
  ciphertext: string;
  nonce: string;
}

/** A relayed WebRTC signal delivered from another peer. */
export interface SignalDeliverMessage {
  type: 'signal';
  from: PeerId;
  signal: RtcSignal;
}

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | 'room-full'
  | 'invalid-room'
  | 'not-in-room'
  | 'bad-request';

/* ------------------------------------------------------------------ */
/* WebRTC signal envelope                                              */
/* ------------------------------------------------------------------ */

export type RtcSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInitLike }
  /** Sender has left the call (but may still be in the room/chat). */
  | { kind: 'bye' };

/** Minimal structural copy of RTCIceCandidateInit (avoids DOM lib in server). */
export interface RTCIceCandidateInitLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/* ------------------------------------------------------------------ */
/* Decrypted application payloads (client-side only, never on wire)    */
/* ------------------------------------------------------------------ */

/** What a sealed chat payload decrypts to. Lives only in client memory. */
export type ChatPayload = TextPayload | TypingPayload;

export interface TextPayload {
  kind: 'text';
  text: string;
  sentAt: number;
}

/** Ephemeral "is typing" signal — sealed per-recipient like a message, never stored. */
export interface TypingPayload {
  kind: 'typing';
  typing: boolean;
  sentAt: number;
}
