/**
 * Shared protocol types between the client and the signaling/relay server.
 *
 * PRIVACY INVARIANT — scoped by trust model:
 *
 * 1. LEGACY ROOMS ('join'/'relay') and E2E CONVERSATIONS: the server only
 *    ever sees ciphertext and routing metadata (room/conversation id, peer
 *    ids, public keys, WebRTC SDP/ICE). It never sees message plaintext. Any
 *    field carrying user content is an opaque base64 blob sealed client-side
 *    with libsodium before transmission, and the server enforces that no
 *    plaintext frame type ('send') is accepted in these contexts.
 *
 * 2. MANAGED CONVERSATIONS (an organization's explicit, at-creation choice):
 *    message text travels in plaintext frames ('send'/'message') and is
 *    stored server-side — that is the feature (shared agent inbox, handoff,
 *    org-controlled history). The org self-hosting the server owns that data.
 *    The server enforces the inverse here: sealed 'relay' frames are
 *    rejected, so a conversation can never silently mix trust models.
 */

export const ROOM_MIN_PEERS = 2;
export const ROOM_MAX_PEERS = 30;

/**
 * Room ids beginning with this prefix are reserved (conversations are
 * addressed by their own message types, never as legacy rooms). The server
 * rejects legacy 'join' for them.
 */
export const RESERVED_ROOM_PREFIX = 'conv:';

/**
 * Calls use full-mesh WebRTC (every participant connects directly to every
 * other, each uploading their own media stream), which caps how far calls
 * can scale independently of the much higher text-chat room cap.
 *
 * Video is the binding constraint: at 30 people, each device would need 29
 * simultaneous video uploads — not viable on ordinary connections. Voice-only
 * mesh is far lighter (audio streams are roughly 15-25x smaller) and
 * tolerates a much bigger room, though reliability still degrades gradually
 * as peer count grows (total connections in the room scale as
 * peers*(peers-1)/2), so this is a practical ceiling, not a hard wall.
 */
export const VIDEO_CALL_MAX_PEERS = 4;
export const VOICE_CALL_MAX_PEERS = 20;

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
  | SignalMessage
  | JoinConversationMessage
  | SendTextMessage
  | JoinInboxMessage;

/** Ask to join (or create) a room and advertise our public identity. */
export interface JoinRoomMessage {
  type: 'join';
  roomId: string;
  publicKey: string;
  displayName: string;
  /**
   * Requested only when this join creates the room (ignored on an existing
   * one — the mode is fixed by whoever created it, see `Room.ephemeral` on
   * the server). When true, the server never writes membership or message
   * ciphertext to the database for this room, regardless of what any later
   * `relay.persist` says — see JoinedMessage.ephemeral for the confirmed,
   * server-authoritative value.
   */
  ephemeral?: boolean;
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

/* --- Organization conversations (customer chat) --------------------- */

/** How a socket proves it may join a conversation. */
export type ConversationAuth =
  /** Dashboard staff: the session cookie already sent on the WS upgrade. */
  | { kind: 'session' }
  /** Anonymous B2C widget visitor. */
  | { kind: 'visitor'; orgSlug: string; secret: string }
  /** Store/marketplace-signed identity token (C2C / identified B2C). */
  | { kind: 'org-token'; token: string };

/**
 * Join an org conversation (created beforehand via the REST API). The server
 * authenticates, authorizes membership, and answers 'conversation-joined'.
 */
export interface JoinConversationMessage {
  type: 'join-conversation';
  conversationId: string;
  auth: ConversationAuth;
  /** E2E conversations only: our X25519 public key so peers can seal to us. */
  publicKey?: string;
}

/**
 * Plaintext message in a MANAGED conversation (the org's explicit choice —
 * see the invariant at the top). Rejected with 'wrong-mode' anywhere else.
 */
export interface SendTextMessage {
  type: 'send';
  text: string;
}

/**
 * Dashboard staff: subscribe this socket to org-wide inbox events
 * (new/updated conversations) using the session cookie from the upgrade.
 */
export interface JoinInboxMessage {
  type: 'join-inbox';
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
  | ErrorMessage
  | ConversationJoinedMessage
  | ConversationMessageEvent
  | ConversationPeerEvent
  | InboxJoinedMessage
  | InboxEventMessage;

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
  /**
   * Server-authoritative: whether this room was created as ephemeral (no DB
   * writes at all — not membership, not message ciphertext). Fixed at
   * creation and the same for every member, regardless of what any
   * individual joiner requested.
   */
  ephemeral: boolean;
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

/* --- Organization conversations: server events ---------------------- */

export type ConversationParticipantKind = 'agent' | 'visitor' | 'external';

/** A conversation participant as seen on the wire. */
export interface ConversationPeer {
  participantId: string;
  kind: ConversationParticipantKind;
  displayName: string;
  /** E2E conversations only. */
  publicKey: string | null;
  online: boolean;
}

/** Answer to 'join-conversation'. */
export interface ConversationJoinedMessage {
  type: 'conversation-joined';
  conversationId: string;
  selfParticipantId: string;
  conversation: {
    kind: 'b2c' | 'c2c';
    encryption: 'e2e' | 'managed';
    status: 'open' | 'closed';
    context: Record<string, unknown> | null;
  };
  participants: ConversationPeer[];
  /** Managed conversations: plaintext history, oldest first. */
  history?: ConversationMessageEvent[];
  /** E2E conversations: sealed history addressed to our key, oldest first. */
  e2eHistory?: HistoryEntry[];
  iceServers: IceServerLike[];
}

/** A managed-mode message, live or replayed as history. */
export interface ConversationMessageEvent {
  type: 'message';
  conversationId: string;
  /** Server-assigned message id (stable, for dedupe). */
  id: string;
  from: {
    participantId: string;
    kind: ConversationParticipantKind;
    displayName: string;
  };
  text: string;
  sentAt: number;
}

/** Presence/roster change inside a conversation. */
export interface ConversationPeerEvent {
  type: 'conversation-peer';
  conversationId: string;
  peer: ConversationPeer;
}

/** Answer to 'join-inbox'. */
export interface InboxJoinedMessage {
  type: 'inbox-joined';
}

/** Org-wide inbox notification for dashboard staff. */
export interface InboxEventMessage {
  type: 'inbox-event';
  event: 'new-conversation' | 'message';
  conversationId: string;
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
  | 'bad-request'
  /** Conversation auth failed or you're not a participant. */
  | 'unauthorized'
  /** Frame type doesn't match the conversation's encryption mode. */
  | 'wrong-mode'
  /** The conversation is closed; reopen it (agent) before sending. */
  | 'conversation-closed';

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
