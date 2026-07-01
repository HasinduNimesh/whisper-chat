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

/**
 * An encrypted chat payload relayed to one recipient, addressed by their
 * permanent public key rather than an ephemeral per-session PeerId — a
 * recipient's PeerId only exists while they're connected, but a message must
 * still be addressable (and persistable) when they're offline.
 */
export interface RelayMessage {
  type: 'relay';
  /** Recipient's base64 X25519 public key. */
  to: string;
  /** Opaque base64 ciphertext (XSalsa20-Poly1305 sealed box). Server never decrypts. */
  ciphertext: string;
  /** base64 nonce for the AEAD. */
  nonce: string;
  /**
   * Store this server-side so the recipient can fetch it later (offline
   * delivery / cross-device history). Set for real messages; omitted/false
   * for ephemeral signals like typing indicators, which the server otherwise
   * can't distinguish from real content (both are opaque ciphertext to it).
   */
  persist?: boolean;
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
  /**
   * Every public key ever seen in this room (excluding self), each flagged
   * with whether they're currently connected. Includes members who are
   * offline right now, so the client can still address (and the server can
   * persist) a message to them.
   */
  members: RoomMember[];
  /**
   * Extra ICE servers (TURN) to use alongside the client's built-in STUN
   * list, minted server-side so no long-lived secret is ever public. Sent
   * only over this authenticated WS connection — never a public HTTP route.
   */
  iceServers: IceServerLike[];
  /** Decryptable history addressed to our own public key, oldest first. */
  history: HistoryEntry[];
}

/** A room's durable member record — may or may not be currently connected. */
export interface RoomMember {
  /** base64 X25519 public key — the durable identity, unlike PeerId. */
  publicKey: string;
  displayName: string;
  online: boolean;
  /** Their current live PeerId, only present when `online` (for call signaling). */
  peerId?: PeerId;
}

/** A stored message addressed to us, to be decrypted and replayed on join. */
export interface HistoryEntry {
  /** Sender's base64 X25519 public key. */
  fromPublicKey: string;
  /** Sender's displayName as it was at send time (may no longer be online). */
  fromDisplayName: string;
  ciphertext: string;
  nonce: string;
  sentAt: number;
}

/** Structural copy of RTCIceServer (avoids pulling the DOM lib into the server). */
export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
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
  /** Sender's base64 X25519 public key (the stable identity, not a PeerId). */
  from: string;
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
