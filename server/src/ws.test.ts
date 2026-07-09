/**
 * Legacy room protocol regression tests — run WITHOUT a database, proving
 * the original private-chat app keeps working exactly as before through
 * every refactor. Real `ws` clients against an in-process server.
 */
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@private-chat/shared';
import { createRequestListener } from './http/app.js';
import { attachSignaling } from './ws.js';

let server: Server;
let wsBase: string;

const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

class TestClient {
  ws: WebSocket;
  received: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(headers?: Record<string, string>) {
    this.ws = new WebSocket(wsBase, { headers });
    this.ws.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as ServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait until a message satisfying `pred` has arrived (5s timeout). */
  async next<T extends ServerMessage>(pred: (m: ServerMessage) => m is T): Promise<T>;
  async next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage>;
  async next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = this.received.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`Timed out waiting; got ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

const roomOne = `test-room-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('legacy room protocol (regression, no DB)', () => {
  beforeAll(async () => {
    server = createServer(createRequestListener());
    attachSignaling(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (typeof addr === 'object' && addr) wsBase = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('join → joined with self id; second peer announces to the first', async () => {
    const a = new TestClient();
    await a.open();
    a.send({ type: 'join', roomId: roomOne, publicKey: KEY_A, displayName: 'Alice' });
    const joinedA = await a.next((m) => m.type === 'joined');
    expect(joinedA.type === 'joined' && joinedA.roomId).toBe(roomOne);
    expect(joinedA.type === 'joined' && joinedA.members).toEqual([]);

    const b = new TestClient();
    await b.open();
    b.send({ type: 'join', roomId: roomOne, publicKey: KEY_B, displayName: 'Bob' });
    const joinedB = await b.next((m) => m.type === 'joined');
    expect(joinedB.type === 'joined' && joinedB.members.map((x) => x.publicKey)).toEqual([KEY_A]);

    const peerJoined = await a.next((m) => m.type === 'peer-joined');
    expect(peerJoined.type === 'peer-joined' && peerJoined.peer.publicKey).toBe(KEY_B);

    // Relay: ciphertext is forwarded byte-for-byte, sender stamped by server.
    a.send({ type: 'relay', to: KEY_B, ciphertext: 'U0VBTEVE', nonce: 'Tk9OQ0U=' });
    const delivered = await b.next((m) => m.type === 'deliver');
    expect(delivered.type === 'deliver' && delivered.from).toBe(KEY_A);
    expect(delivered.type === 'deliver' && delivered.ciphertext).toBe('U0VBTEVE');

    // Signaling relays by peer id.
    const bId = joinedB.type === 'joined' ? joinedB.selfId : '';
    a.send({ type: 'signal', to: bId, signal: { kind: 'bye' } });
    const signal = await b.next((m) => m.type === 'signal');
    expect(signal.type === 'signal' && signal.signal.kind).toBe('bye');

    // Leaving announces peer-left.
    b.close();
    const left = await a.next((m) => m.type === 'peer-left');
    expect(left.type === 'peer-left' && left.peerId).toBe(bId);
    a.close();
  });

  it('rejects invalid joins: bad key, reserved conv: prefix, double join', async () => {
    const c = new TestClient();
    await c.open();

    c.send({ type: 'join', roomId: 'x', publicKey: 'tooshort', displayName: 'Eve' });
    const badKey = await c.next((m) => m.type === 'error');
    expect(badKey.type === 'error' && badKey.code).toBe('bad-request');

    c.send({ type: 'join', roomId: 'conv:0000-reserved', publicKey: KEY_A, displayName: 'Eve' });
    const reserved = await c.next(
      (m) => m.type === 'error' && m.code === 'invalid-room' && m.message === 'Reserved room id',
    );
    expect(reserved.type).toBe('error');

    c.send({ type: 'join', roomId: `ok-${run}`, publicKey: KEY_A, displayName: 'Eve' });
    await c.next((m) => m.type === 'joined');
    c.send({ type: 'join', roomId: 'another', publicKey: KEY_A, displayName: 'Eve' });
    const dbl = await c.next(
      (m) => m.type === 'error' && m.message === 'Already in a room',
    );
    expect(dbl.type).toBe('error');
    c.close();
  });

  it('rejects relay/signal/send before joining; unknown types error', async () => {
    const c = new TestClient();
    await c.open();

    c.send({ type: 'relay', to: KEY_A, ciphertext: 'eA==', nonce: 'eQ==' });
    expect(
      (await c.next((m) => m.type === 'error' && m.code === 'not-in-room')).type,
    ).toBe('error');

    c.send({ type: 'send', text: 'hi' });
    const sendErr = await c.next(
      (m) => m.type === 'error' && m.message === 'Join a conversation first',
    );
    expect(sendErr.type).toBe('error');

    c.send({ type: 'nonsense' });
    expect(
      (await c.next((m) => m.type === 'error' && m.message === 'Unknown message type')).type,
    ).toBe('error');
    c.close();
  });

  it('conversation joins require auth (no cookie → unauthorized)', async () => {
    const c = new TestClient();
    await c.open();
    c.send({
      type: 'join-conversation',
      conversationId: '00000000-0000-0000-0000-000000000000',
      auth: { kind: 'session' },
    });
    const err = await c.next((m) => m.type === 'error');
    // Without a DB this surfaces as unauthorized either way — the socket
    // never learns whether the conversation exists.
    expect(err.type === 'error' && err.code).toBe('unauthorized');
    c.close();
  });
});
