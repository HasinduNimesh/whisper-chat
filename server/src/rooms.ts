/**
 * In-memory room registry. Holds NO message content — only routing state
 * (peer ids, public keys, display names, socket handles). Everything is
 * ephemeral and lost on restart, by design (privacy-first, no persistence).
 */
import type { WebSocket } from 'ws';
import {
  ROOM_MAX_PEERS,
  type PeerId,
  type PeerIdentity,
} from '@private-chat/shared';

export interface Peer {
  id: PeerId;
  socket: WebSocket;
  publicKey: string;
  displayName: string;
  roomId: string;
}

export interface Room {
  id: string;
  peers: Map<PeerId, Peer>;
}

const rooms = new Map<string, Room>();

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export type JoinResult =
  | { ok: true; room: Room }
  | { ok: false; reason: 'room-full' };

/** Add a peer to a room (creating the room if needed). Enforces the 4-peer cap. */
export function joinRoom(roomId: string, peer: Peer): JoinResult {
  let room = rooms.get(roomId);
  if (!room) {
    room = { id: roomId, peers: new Map() };
    rooms.set(roomId, room);
  }
  if (room.peers.size >= ROOM_MAX_PEERS) {
    return { ok: false, reason: 'room-full' };
  }
  room.peers.set(peer.id, peer);
  return { ok: true, room };
}

/** Remove a peer; deletes the room when it becomes empty. */
export function leaveRoom(peer: Peer): Room | undefined {
  const room = rooms.get(peer.roomId);
  if (!room) return undefined;
  room.peers.delete(peer.id);
  if (room.peers.size === 0) {
    rooms.delete(room.id);
    return undefined;
  }
  return room;
}

/** Public identity view of a peer (safe to share with other peers). */
export function toIdentity(peer: Peer): PeerIdentity {
  return {
    peerId: peer.id,
    publicKey: peer.publicKey,
    displayName: peer.displayName,
  };
}

export { ROOM_MAX_PEERS };
