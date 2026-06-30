/**
 * Minimal WebSocket signaling + relay server.
 *
 * Responsibilities (ALL it is allowed to do):
 *  - assign peer ids, manage room membership / presence (2-4 cap)
 *  - relay opaque encrypted chat blobs between peers
 *  - relay WebRTC SDP/ICE signaling between peers
 *
 * It deliberately cannot read message content: chat payloads arrive already
 * sealed with XChaCha20-Poly1305 and are forwarded byte-for-byte.
 */
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  ClientMessage,
  ServerMessage,
  ErrorCode,
} from '@private-chat/shared';
import {
  getRoom,
  joinRoom,
  leaveRoom,
  toIdentity,
  type Peer,
} from './rooms.js';

const PORT = Number(process.env.PORT ?? 8787);
// Bind address. Default (unset) listens on all interfaces — good for LAN/dev.
// Behind a reverse proxy (nginx), set HOST=127.0.0.1 to keep it private.
const HOST = process.env.HOST;
const MAX_PAYLOAD = 256 * 1024; // 256 KiB cap per frame

const wss = new WebSocketServer({ port: PORT, host: HOST, maxPayload: MAX_PAYLOAD });

/** Per-socket state: the peer record once joined. */
const peerOf = new WeakMap<WebSocket, Peer>();

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function fail(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { type: 'error', code, message });
}

function handleJoin(socket: WebSocket, roomId: string, publicKey: string, displayName: string): void {
  if (peerOf.has(socket)) {
    fail(socket, 'bad-request', 'Already in a room');
    return;
  }
  if (!roomId || typeof roomId !== 'string' || roomId.length > 128) {
    fail(socket, 'invalid-room', 'Invalid room id');
    return;
  }
  const peer: Peer = {
    id: randomUUID(),
    socket,
    publicKey: String(publicKey).slice(0, 128),
    displayName: String(displayName ?? '').slice(0, 64) || 'Anonymous',
    roomId,
  };
  const result = joinRoom(roomId, peer);
  if (!result.ok) {
    fail(socket, 'room-full', 'This room is full (max 4 people)');
    return;
  }
  peerOf.set(socket, peer);

  // Tell the newcomer who is already here.
  const existing = [...result.room.peers.values()]
    .filter((p) => p.id !== peer.id)
    .map(toIdentity);
  send(socket, { type: 'joined', selfId: peer.id, roomId, peers: existing });

  // Announce the newcomer to everyone else.
  for (const other of result.room.peers.values()) {
    if (other.id === peer.id) continue;
    send(other.socket, { type: 'peer-joined', peer: toIdentity(peer) });
  }
}

function handleLeave(socket: WebSocket): void {
  const peer = peerOf.get(socket);
  if (!peer) return;
  peerOf.delete(socket);
  const room = leaveRoom(peer);
  if (!room) return;
  for (const other of room.peers.values()) {
    send(other.socket, { type: 'peer-left', peerId: peer.id });
  }
}

function handleRelay(socket: WebSocket, msg: Extract<ClientMessage, { type: 'relay' }>): void {
  const peer = peerOf.get(socket);
  if (!peer) return fail(socket, 'not-in-room', 'Join a room first');
  const room = getRoom(peer.roomId);
  if (!room) return;
  for (const other of room.peers.values()) {
    if (other.id === peer.id) continue;
    if (msg.to !== 'all' && msg.to !== other.id) continue;
    send(other.socket, {
      type: 'deliver',
      from: peer.id,
      ciphertext: msg.ciphertext,
      nonce: msg.nonce,
    });
  }
}

function handleSignal(socket: WebSocket, msg: Extract<ClientMessage, { type: 'signal' }>): void {
  const peer = peerOf.get(socket);
  if (!peer) return fail(socket, 'not-in-room', 'Join a room first');
  const room = getRoom(peer.roomId);
  if (!room) return;
  const target = room.peers.get(msg.to);
  if (!target) return;
  send(target.socket, { type: 'signal', from: peer.id, signal: msg.signal });
}

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return fail(socket, 'bad-request', 'Malformed JSON');
    }
    switch (msg?.type) {
      case 'join':
        return handleJoin(socket, msg.roomId, msg.publicKey, msg.displayName);
      case 'leave':
        return handleLeave(socket);
      case 'relay':
        return handleRelay(socket, msg);
      case 'signal':
        return handleSignal(socket, msg);
      default:
        return fail(socket, 'bad-request', 'Unknown message type');
    }
  });

  socket.on('close', () => handleLeave(socket));
  socket.on('error', () => handleLeave(socket));
});

console.log(`[signaling] listening on ws://${HOST ?? '0.0.0.0'}:${PORT}`);
