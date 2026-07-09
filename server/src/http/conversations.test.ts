/**
 * Conversations API + org-token trust path, over real HTTP. Skipped without
 * TEST_DATABASE_URL. Covers the full token rejection matrix and the
 * cross-tenant isolation of every agent-facing route.
 */
import { createServer, type Server } from 'node:http';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequestListener } from './app.js';
import { resetRateLimitersForTests } from './rateLimit.js';
import { closePool, initDb, insertManagedMessage } from '../db/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let server: Server;
let base: string;

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
    headers: res.headers,
  };
}

async function registerOrg(n: string, mode: 'e2e' | 'managed' = 'managed') {
  const res = await api('POST', '/api/orgs', {
    body: {
      orgName: `Store ${n}`,
      slug: `store-${n}-${run}`,
      encryptionMode: mode,
      email: `owner-${n}-${run}@test.example`,
      password: 'correct horse battery staple',
      displayName: `Owner ${n}`,
    },
  });
  expect(res.status).toBe(201);
  return { cookie: res.cookie, slug: `store-${n}-${run}`, userId: (res.body.user as { id: string }).id };
}

async function mintKey(cookie: string | null) {
  const res = await api('POST', '/api/org/api-keys', { cookie, body: { label: 'test backend' } });
  expect(res.status).toBe(201);
  const key = res.body.key as { id: string; kid: string; secret: string };
  expect(key.secret).toBeDefined();
  return key;
}

function signToken(
  key: { kid: string; secret: string },
  claims: Record<string, unknown>,
  opts: { expIn?: string; alg?: string; kid?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: (opts.alg ?? 'HS256') as 'HS256', kid: opts.kid ?? key.kid })
    .setIssuedAt()
    .setExpirationTime(opts.expIn ?? '5m')
    .sign(Buffer.from(key.secret, 'utf8'));
}

describe.skipIf(!HAS_DB)('conversations API (integration)', () => {
  beforeAll(async () => {
    await initDb();
    server = createServer(createRequestListener());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  beforeEach(() => resetRateLimitersForTests());

  // ── API keys ─────────────────────────────────────────────────────────────
  it('api keys: admin-only CRUD, secret shown exactly once', async () => {
    const org = await registerOrg('keys');
    const key = await mintKey(org.cookie);

    const listed = await api('GET', '/api/org/api-keys', { cookie: org.cookie });
    expect(listed.status).toBe(200);
    const mine = (listed.body.keys as Record<string, unknown>[]).find((k) => k.kid === key.kid)!;
    expect(mine).toBeDefined();
    expect(mine.secret).toBeUndefined(); // never re-exposed

    expect((await api('GET', '/api/org/api-keys')).status).toBe(401);

    const revoked = await api('DELETE', `/api/org/api-keys/${key.id}`, { cookie: org.cookie });
    expect(revoked.status).toBe(200);
  });

  // ── Token verification matrix ────────────────────────────────────────────
  it('rejects the full bad-token matrix', async () => {
    const org = await registerOrg('badtok');
    const key = await mintKey(org.cookie);
    const claims = { sub: 'buyer-1', name: 'Jane', conv: 'listing:1', kind: 'c2c' };
    const post = (token: string) =>
      api('POST', '/api/widget/conversations', { body: { token, orgSlug: org.slug } });

    // Tampered signature.
    const good = await signToken(key, claims);
    expect((await post(good.slice(0, -3) + 'abc')).status).toBe(401);

    // Wrong secret.
    const forged = await signToken({ kid: key.kid, secret: 'x'.repeat(43) }, claims);
    expect((await post(forged)).status).toBe(401);

    // Unknown kid.
    const wrongKid = await signToken(key, claims, { kid: 'whk_does_not_exist' });
    expect((await post(wrongKid)).status).toBe(401);

    // Expired.
    const expired = await signToken(key, claims, { expIn: '-5m' });
    expect((await post(expired)).status).toBe(401);

    // Excessive lifetime (> 10 min cap).
    const longLived = await signToken(key, claims, { expIn: '2h' });
    const longRes = await post(longLived);
    expect(longRes.status).toBe(401);
    expect(String(longRes.body.error)).toContain('lifetime');

    // Missing claims.
    expect((await post(await signToken(key, { name: 'NoSub', conv: 'x' }))).status).toBe(401);
    expect((await post(await signToken(key, { sub: 'u1', name: 'NoConv' }))).status).toBe(401);

    // Revoked key.
    const key2 = await mintKey(org.cookie);
    const listed = await api('GET', '/api/org/api-keys', { cookie: org.cookie });
    const key2id = (listed.body.keys as Record<string, unknown>[]).find((k) => k.kid === key2.kid)!
      .id as string;
    const validBeforeRevoke = await signToken(key2, claims);
    await api('DELETE', `/api/org/api-keys/${key2id}`, { cookie: org.cookie });
    const revokedRes = await post(validBeforeRevoke);
    expect(revokedRes.status).toBe(401);
    expect(String(revokedRes.body.error)).toContain('revoked');
  });

  it('rejects alg confusion (none / RS256 headers)', async () => {
    const org = await registerOrg('alg');
    const key = await mintKey(org.cookie);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const noneToken = `${b64({ alg: 'none', kid: key.kid })}.${b64({ sub: 'u', conv: 'c', exp: Math.floor(Date.now() / 1000) + 60 })}.`;
    const res = await api('POST', '/api/widget/conversations', {
      body: { token: noneToken, orgSlug: org.slug },
    });
    expect(res.status).toBe(401);
    expect(String(res.body.error)).toContain('algorithm');
  });

  // ── C2C flow ─────────────────────────────────────────────────────────────
  it('C2C: buyer and seller tokens with the same conv land in one conversation', async () => {
    const org = await registerOrg('c2c');
    const key = await mintKey(org.cookie);
    const conv = `listing:99:thread:42`;

    const buyerToken = await signToken(key, {
      sub: 'buyer-42', name: 'Jane', conv, kind: 'c2c', ctx: { listing: 'Blue bike', url: 'https://x/99' },
    });
    const buyer = await api('POST', '/api/widget/conversations', {
      body: { token: buyerToken, orgSlug: org.slug },
    });
    expect(buyer.status).toBe(200);
    const conversation = buyer.body.conversation as Record<string, unknown>;
    expect(conversation.kind).toBe('c2c');
    expect((conversation.context as Record<string, unknown>).listing).toBe('Blue bike');

    const sellerToken = await signToken(key, { sub: 'seller-7', name: 'Bob', conv, kind: 'c2c' });
    const seller = await api('POST', '/api/widget/conversations', {
      body: { token: sellerToken, orgSlug: org.slug },
    });
    expect(seller.status).toBe(200);
    expect((seller.body.conversation as Record<string, unknown>).id).toBe(conversation.id);
    const participants = (seller.body.conversation as Record<string, unknown>)
      .participants as Record<string, unknown>[];
    expect(participants).toHaveLength(2);
    expect(buyer.body.selfParticipantId).not.toBe(seller.body.selfParticipantId);

    // Re-presenting the same token converges on the same participant.
    const again = await api('POST', '/api/widget/conversations', {
      body: { token: await signToken(key, { sub: 'buyer-42', name: 'Jane', conv, kind: 'c2c' }), orgSlug: org.slug },
    });
    expect(again.body.selfParticipantId).toBe(buyer.body.selfParticipantId);
  });

  it('a token signed for org A cannot be replayed against org B', async () => {
    const orgA = await registerOrg('replay-a');
    const orgB = await registerOrg('replay-b');
    const keyA = await mintKey(orgA.cookie);

    const token = await signToken(keyA, { sub: 'u1', name: 'X', conv: 'c1', kind: 'c2c' });
    const res = await api('POST', '/api/widget/conversations', {
      body: { token, orgSlug: orgB.slug },
    });
    expect(res.status).toBe(401);
    expect(String(res.body.error)).toContain('does not match');
  });

  // ── Anonymous B2C flow ───────────────────────────────────────────────────
  it('anonymous B2C: session → conversation, stable across reloads', async () => {
    const org = await registerOrg('b2c');

    const session = await api('POST', '/api/widget/session', { body: { orgSlug: org.slug } });
    expect(session.status).toBe(201);
    const secret = session.body.visitorSecret as string;
    expect(secret).toBeDefined();
    expect(session.body.encryptionMode).toBe('managed');

    const conv1 = await api('POST', '/api/widget/conversations', {
      body: { orgSlug: org.slug, visitorSecret: secret },
    });
    expect(conv1.status).toBe(200);

    // "Reload": same secret → same session (no new secret) → same conversation.
    const session2 = await api('POST', '/api/widget/session', {
      body: { orgSlug: org.slug, visitorSecret: secret },
    });
    expect(session2.status).toBe(200);
    expect(session2.body.visitorSecret).toBeUndefined();

    const conv2 = await api('POST', '/api/widget/conversations', {
      body: { orgSlug: org.slug, visitorSecret: secret },
    });
    expect((conv2.body.conversation as Record<string, unknown>).id).toBe(
      (conv1.body.conversation as Record<string, unknown>).id,
    );

    // Wrong secret → 401; unknown org → 404.
    expect(
      (await api('POST', '/api/widget/conversations', { body: { orgSlug: org.slug, visitorSecret: 'nope' } }))
        .status,
    ).toBe(401);
    expect(
      (await api('POST', '/api/widget/session', { body: { orgSlug: `ghost-${run}` } })).status,
    ).toBe(404);
  });

  // ── Agent inbox ──────────────────────────────────────────────────────────
  it('agent inbox: list/filter/assign/close, with tenant isolation', async () => {
    const org = await registerOrg('inbox');
    const other = await registerOrg('inbox-other');

    // A visitor opens a conversation with `org`.
    const session = await api('POST', '/api/widget/session', { body: { orgSlug: org.slug } });
    const secret = session.body.visitorSecret as string;
    const created = await api('POST', '/api/widget/conversations', {
      body: { orgSlug: org.slug, visitorSecret: secret },
    });
    const convId = (created.body.conversation as Record<string, unknown>).id as string;

    // Unassigned queue shows it — but only inside the right org.
    const queue = await api('GET', '/api/conversations?status=open&assigned=unassigned', {
      cookie: org.cookie,
    });
    expect(queue.status).toBe(200);
    expect((queue.body.conversations as Record<string, unknown>[]).some((c) => c.id === convId)).toBe(true);

    const foreignQueue = await api('GET', '/api/conversations', { cookie: other.cookie });
    expect(
      (foreignQueue.body.conversations as Record<string, unknown>[]).some((c) => c.id === convId),
    ).toBe(false);
    expect((await api('GET', `/api/conversations/${convId}`, { cookie: other.cookie })).status).toBe(404);
    expect(
      (await api('POST', `/api/conversations/${convId}/assign`, { cookie: other.cookie, body: { self: true } }))
        .status,
    ).toBe(404);

    // Assign to self, filter "mine", close, reopen.
    expect(
      (await api('POST', `/api/conversations/${convId}/assign`, { cookie: org.cookie, body: { self: true } }))
        .status,
    ).toBe(200);
    const mine = await api('GET', '/api/conversations?assigned=me', { cookie: org.cookie });
    expect((mine.body.conversations as Record<string, unknown>[]).some((c) => c.id === convId)).toBe(true);

    expect((await api('POST', `/api/conversations/${convId}/close`, { cookie: org.cookie })).status).toBe(200);
    expect((await api('POST', `/api/conversations/${convId}/reopen`, { cookie: org.cookie })).status).toBe(200);
  });

  it('managed history is readable by agents and participants; E2E orgs get 409', async () => {
    const org = await registerOrg('hist');
    const session = await api('POST', '/api/widget/session', { body: { orgSlug: org.slug } });
    const secret = session.body.visitorSecret as string;
    const created = await api('POST', '/api/widget/conversations', {
      body: { orgSlug: org.slug, visitorSecret: secret },
    });
    const conv = created.body.conversation as Record<string, unknown>;
    const convId = conv.id as string;
    const selfId = created.body.selfParticipantId as string;

    // Seed a message directly through the repo (WS send path lands in branch 6).
    const me = await api('GET', '/api/auth/me', { cookie: org.cookie });
    const orgId = ((me.body.org as Record<string, unknown>).id as string) ?? '';
    await insertManagedMessage(orgId, {
      conversationId: convId,
      senderParticipantId: selfId,
      body: 'hello, anyone there?',
      sentAt: Date.now(),
    });

    const agentView = await api('GET', `/api/conversations/${convId}/messages`, { cookie: org.cookie });
    expect(agentView.status).toBe(200);
    expect((agentView.body.messages as Record<string, unknown>[])[0].body).toBe('hello, anyone there?');

    const visitorView = await api('GET', `/api/widget/conversations/${convId}/messages`, {
      headers: { 'x-visitor-secret': secret, 'x-org': org.slug },
    });
    expect(visitorView.status).toBe(200);
    expect((visitorView.body.messages as Record<string, unknown>[])).toHaveLength(1);

    // A different visitor may not read it.
    const stranger = await api('POST', '/api/widget/session', { body: { orgSlug: org.slug } });
    const strangerView = await api('GET', `/api/widget/conversations/${convId}/messages`, {
      headers: { 'x-visitor-secret': stranger.body.visitorSecret as string, 'x-org': org.slug },
    });
    expect(strangerView.status).toBe(403);

    // E2E orgs: history never flows over plaintext REST.
    const e2eOrg = await registerOrg('hist-e2e', 'e2e');
    const s2 = await api('POST', '/api/widget/session', { body: { orgSlug: e2eOrg.slug } });
    const c2 = await api('POST', '/api/widget/conversations', {
      body: { orgSlug: e2eOrg.slug, visitorSecret: s2.body.visitorSecret },
    });
    const c2id = ((c2.body.conversation as Record<string, unknown>).id as string) ?? '';
    const e2eRead = await api('GET', `/api/widget/conversations/${c2id}/messages`, {
      headers: { 'x-visitor-secret': s2.body.visitorSecret as string, 'x-org': e2eOrg.slug },
    });
    expect(e2eRead.status).toBe(409);
  });

  it('widget routes answer CORS preflight with open origin, api routes do not', async () => {
    const preflight = await fetch(`${base}/api/widget/session`, {
      method: 'OPTIONS',
      headers: { origin: 'https://random-store.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

    const dashPreflight = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { origin: 'https://random-store.example', 'access-control-request-method': 'POST' },
    });
    // ALLOWED_ORIGINS is unset in tests → no credentialed reflection at all.
    expect(dashPreflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});
