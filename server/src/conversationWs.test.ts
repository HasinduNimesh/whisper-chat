/**
 * Conversation wire-protocol integration tests: managed + E2E modes, auth
 * matrix, mode enforcement, presence, inbox events. Needs a database
 * (TEST_DATABASE_URL); real HTTP + real `ws` sockets.
 */
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@private-chat/shared';
import { createRequestListener } from './http/app.js';
import { attachSignaling } from './ws.js';
import { resetRateLimitersForTests } from './http/rateLimit.js';
import { closePool, initDb } from './db/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let server: Server;
let base: string;
let wsBase: string;

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-requested-with': 'fetch',
    ...(opts.headers ?? {}),
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

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

  async next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = this.received.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`Timed out; got ${JSON.stringify(this.received)}`);
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

async function registerOrg(n: string, mode: 'e2e' | 'managed') {
  const res = await api('POST', '/api/orgs', {
    body: {
      orgName: `Org ${n}`,
      slug: `ws-${n}-${run}`,
      encryptionMode: mode,
      email: `owner-ws-${n}-${run}@test.example`,
      password: 'correct horse battery staple',
      displayName: `Owner ${n}`,
    },
  });
  expect(res.status).toBe(201);
  return { cookie: res.cookie!, slug: `ws-${n}-${run}` };
}

async function visitorConversation(orgSlug: string, publicKey?: string) {
  const session = await api('POST', '/api/widget/session', { body: { orgSlug } });
  const secret = (session.body.visitorSecret as string) ?? '';
  const created = await api('POST', '/api/widget/conversations', {
    body: { orgSlug, visitorSecret: secret, ...(publicKey ? { publicKey } : {}) },
  });
  expect(created.status).toBe(200);
  return {
    secret,
    conversationId: (created.body.conversation as { id: string }).id,
    selfParticipantId: created.body.selfParticipantId as string,
  };
}

describe.skipIf(!HAS_DB)('conversation wire protocol (integration)', () => {
  beforeAll(async () => {
    await initDb();
    server = createServer(createRequestListener());
    attachSignaling(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      base = `http://127.0.0.1:${addr.port}`;
      wsBase = `ws://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  beforeEach(() => resetRateLimitersForTests());

  it('managed flow: visitor and agent exchange plaintext, history replays, inbox pings', async () => {
    const org = await registerOrg('managed', 'managed');
    const { secret, conversationId } = await visitorConversation(org.slug);

    // Agent subscribes to the org inbox.
    const inbox = new TestClient({ cookie: org.cookie });
    await inbox.open();
    inbox.send({ type: 'join-inbox' });
    await inbox.next((m) => m.type === 'inbox-joined');

    // Visitor joins over WS with their secret.
    const visitor = new TestClient();
    await visitor.open();
    visitor.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'visitor', orgSlug: org.slug, secret },
    });
    const vJoined = await visitor.next((m) => m.type === 'conversation-joined');
    expect(vJoined.type === 'conversation-joined' && vJoined.conversation.encryption).toBe('managed');
    expect(vJoined.type === 'conversation-joined' && vJoined.history).toEqual([]);

    // Agent joins with their session cookie.
    const agent = new TestClient({ cookie: org.cookie });
    await agent.open();
    agent.send({ type: 'join-conversation', conversationId, auth: { kind: 'session' } });
    const aJoined = await agent.next((m) => m.type === 'conversation-joined');
    expect(aJoined.type === 'conversation-joined').toBe(true);

    // Visitor sees the agent come online.
    const presence = await visitor.next(
      (m) => m.type === 'conversation-peer' && m.peer.kind === 'agent' && m.peer.online,
    );
    expect(presence.type).toBe('conversation-peer');

    // Visitor sends → agent receives, sender gets the echo, inbox pings.
    visitor.send({ type: 'send', text: 'hello, I need help with my order' });
    const got = await agent.next((m) => m.type === 'message');
    expect(got.type === 'message' && got.text).toBe('hello, I need help with my order');
    expect(got.type === 'message' && got.from.kind).toBe('visitor');
    await visitor.next((m) => m.type === 'message'); // echo/ack
    await inbox.next((m) => m.type === 'inbox-event' && m.event === 'message');

    // Agent replies.
    agent.send({ type: 'send', text: 'happy to help!' });
    const reply = await visitor.next((m) => m.type === 'message' && m.from.kind === 'agent');
    expect(reply.type === 'message' && reply.text).toBe('happy to help!');

    // Sealed relay frames are rejected in managed conversations.
    agent.send({ type: 'relay', to: Buffer.alloc(32, 9).toString('base64'), ciphertext: 'eA==', nonce: 'eQ==' });
    const wrongMode = await agent.next((m) => m.type === 'error' && m.code === 'wrong-mode');
    expect(wrongMode.type).toBe('error');

    // Reconnecting replays history in order.
    const visitor2 = new TestClient();
    await visitor2.open();
    visitor2.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'visitor', orgSlug: org.slug, secret },
    });
    const rejoined = await visitor2.next((m) => m.type === 'conversation-joined');
    const history = rejoined.type === 'conversation-joined' ? (rejoined.history ?? []) : [];
    expect(history.map((h) => h.text)).toEqual(['hello, I need help with my order', 'happy to help!']);

    inbox.close();
    visitor.close();
    visitor2.close();
    agent.close();
  });

  it('closed conversations reject sends until reopened', async () => {
    const org = await registerOrg('closed', 'managed');
    const { secret, conversationId } = await visitorConversation(org.slug);
    await api('POST', `/api/conversations/${conversationId}/close`, { cookie: org.cookie });

    const visitor = new TestClient();
    await visitor.open();
    visitor.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'visitor', orgSlug: org.slug, secret },
    });
    await visitor.next((m) => m.type === 'conversation-joined');
    visitor.send({ type: 'send', text: 'anyone?' });
    const closed = await visitor.next((m) => m.type === 'error' && m.code === 'conversation-closed');
    expect(closed.type).toBe('error');
    visitor.close();
  });

  it('auth matrix: wrong secret, foreign org agent, and mismatched token conv are all unauthorized', async () => {
    const org = await registerOrg('authz', 'managed');
    const foreign = await registerOrg('authz-foreign', 'managed');
    const { conversationId } = await visitorConversation(org.slug);

    // Visitor with a bogus secret.
    const bad = new TestClient();
    await bad.open();
    bad.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'visitor', orgSlug: org.slug, secret: 'bogus' },
    });
    expect(
      (await bad.next((m) => m.type === 'error' && m.code === 'unauthorized')).type,
    ).toBe('error');
    bad.close();

    // A different visitor of the same org (valid secret, not a participant).
    const stranger = await api('POST', '/api/widget/session', { body: { orgSlug: org.slug } });
    const strangerWs = new TestClient();
    await strangerWs.open();
    strangerWs.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'visitor', orgSlug: org.slug, secret: stranger.body.visitorSecret },
    });
    expect(
      (await strangerWs.next((m) => m.type === 'error' && m.code === 'unauthorized')).type,
    ).toBe('error');
    strangerWs.close();

    // An agent of another org, with a perfectly valid session — cross-tenant.
    const foreignAgent = new TestClient({ cookie: foreign.cookie });
    await foreignAgent.open();
    foreignAgent.send({ type: 'join-conversation', conversationId, auth: { kind: 'session' } });
    expect(
      (await foreignAgent.next((m) => m.type === 'error' && m.code === 'unauthorized')).type,
    ).toBe('error');
    foreignAgent.close();

    // A valid org token whose conv key doesn't match this conversation.
    const keyRes = await api('POST', '/api/org/api-keys', { cookie: org.cookie, body: { label: 't' } });
    const key = (keyRes.body.key ?? {}) as { kid: string; secret: string };
    const token = await new SignJWT({ sub: 'u1', name: 'U', conv: 'some-other-conv', kind: 'c2c' })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(Buffer.from(key.secret, 'utf8'));
    const tokenWs = new TestClient();
    await tokenWs.open();
    tokenWs.send({ type: 'join-conversation', conversationId, auth: { kind: 'org-token', token } });
    expect(
      (await tokenWs.next((m) => m.type === 'error' && m.code === 'unauthorized')).type,
    ).toBe('error');
    tokenWs.close();
  });

  it('E2E flow: sealed relay between token participants, ciphertext history, send rejected', async () => {
    const org = await registerOrg('e2e', 'e2e');
    const keyRes = await api('POST', '/api/org/api-keys', { cookie: org.cookie, body: { label: 'e2e' } });
    const key = (keyRes.body.key ?? {}) as { kid: string; secret: string };
    const conv = `listing:1:pair:${run}`;
    const sign = (sub: string, name: string) =>
      new SignJWT({ sub, name, conv, kind: 'c2c' })
        .setProtectedHeader({ alg: 'HS256', kid: key.kid })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(Buffer.from(key.secret, 'utf8'));

    const KEY_BUYER = Buffer.alloc(32, 3).toString('base64');
    const KEY_SELLER = Buffer.alloc(32, 4).toString('base64');

    // Create the conversation via REST (buyer side).
    const buyerToken = await sign('buyer-1', 'Jane');
    const created = await api('POST', '/api/widget/conversations', {
      body: { token: buyerToken, orgSlug: org.slug, publicKey: KEY_BUYER },
    });
    expect(created.status).toBe(200);
    const conversationId = (created.body.conversation as { id: string }).id;

    const buyer = new TestClient();
    await buyer.open();
    buyer.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'org-token', token: await sign('buyer-1', 'Jane') },
      publicKey: KEY_BUYER,
    });
    const bJoined = await buyer.next((m) => m.type === 'conversation-joined');
    expect(bJoined.type === 'conversation-joined' && bJoined.conversation.encryption).toBe('e2e');
    expect(bJoined.type === 'conversation-joined' && bJoined.e2eHistory).toEqual([]);

    const seller = new TestClient();
    await seller.open();
    seller.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'org-token', token: await sign('seller-9', 'Bob') },
      publicKey: KEY_SELLER,
    });
    await seller.next((m) => m.type === 'conversation-joined');

    // Plaintext send must be rejected in E2E conversations.
    buyer.send({ type: 'send', text: 'plaintext should not pass' });
    expect(
      (await buyer.next((m) => m.type === 'error' && m.code === 'wrong-mode')).type,
    ).toBe('error');

    // Sealed relay: delivered live and persisted per recipient.
    buyer.send({ type: 'relay', to: KEY_SELLER, ciphertext: 'Q0lQSEVS', nonce: 'Tk9OQ0U=', persist: true });
    const delivered = await seller.next((m) => m.type === 'deliver');
    expect(delivered.type === 'deliver' && delivered.from).toBe(KEY_BUYER);
    expect(delivered.type === 'deliver' && delivered.ciphertext).toBe('Q0lQSEVS');

    // Seller reconnects: the ciphertext replays as e2eHistory for their key.
    seller.close();
    const seller2 = new TestClient();
    await seller2.open();
    seller2.send({
      type: 'join-conversation',
      conversationId,
      auth: { kind: 'org-token', token: await sign('seller-9', 'Bob') },
      publicKey: KEY_SELLER,
    });
    const rejoined = await seller2.next((m) => m.type === 'conversation-joined');
    const hist = rejoined.type === 'conversation-joined' ? (rejoined.e2eHistory ?? []) : [];
    expect(hist).toHaveLength(1);
    expect(hist[0].ciphertext).toBe('Q0lQSEVS');
    expect(hist[0].fromPublicKey).toBe(KEY_BUYER);

    buyer.close();
    seller2.close();
  });
});
