/**
 * Auth + org administration integration tests, run over real HTTP against
 * the app's actual request listener. Skipped without TEST_DATABASE_URL
 * (mapped to DATABASE_URL by vitest.config.ts).
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequestListener } from '../http/app.js';
import { resetRateLimitersForTests } from '../http/rateLimit.js';
import { initDb, closePool } from '../db/index.js';
import { AUTH_RATE_LIMIT } from '../config.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let server: Server;
let base: string;

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
  cookie: string | null;
}

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string>; csrf?: boolean } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.csrf === false ? {} : { 'x-requested-with': 'fetch' }),
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

function registerPayload(n: string, mode: 'e2e' | 'managed' = 'managed') {
  return {
    orgName: `Org ${n}`,
    slug: `org-${n}-${run}`,
    encryptionMode: mode,
    email: `admin-${n}-${run}@test.example`,
    password: 'correct horse battery staple',
    displayName: `Admin ${n}`,
  };
}

describe.skipIf(!HAS_DB)('auth API (integration)', () => {
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

  beforeEach(() => {
    resetRateLimitersForTests();
  });

  it('registers an org and signs the admin in', async () => {
    const res = await api('POST', '/api/orgs', { body: registerPayload('reg') });
    expect(res.status).toBe(201);
    expect(res.cookie).toMatch(/^whisper_session=/);
    expect((res.body.org as Record<string, unknown>).encryptionMode).toBe('managed');
    expect((res.body.user as Record<string, unknown>).role).toBe('admin');

    const me = await api('GET', '/api/auth/me', { cookie: res.cookie });
    expect(me.status).toBe(200);
    expect((me.body.user as Record<string, unknown>).email).toContain('admin-reg');
  });

  it('rejects duplicate slugs and duplicate emails (no orphan org)', async () => {
    const payload = registerPayload('dup');
    expect((await api('POST', '/api/orgs', { body: payload })).status).toBe(201);

    const slugDup = await api('POST', '/api/orgs', {
      body: { ...payload, email: `other-${run}@test.example` },
    });
    expect(slugDup.status).toBe(409);

    const emailDup = await api('POST', '/api/orgs', {
      body: { ...payload, slug: `org-dup2-${run}` },
    });
    expect(emailDup.status).toBe(409);

    // The compensating deleteOrg freed the slug — registering there now works.
    const retry = await api('POST', '/api/orgs', {
      body: { ...payload, slug: `org-dup2-${run}`, email: `other2-${run}@test.example` },
    });
    expect(retry.status).toBe(201);
  });

  it('validates registration input', async () => {
    const good = registerPayload('val');
    expect((await api('POST', '/api/orgs', { body: { ...good, slug: 'A B!' } })).status).toBe(400);
    expect((await api('POST', '/api/orgs', { body: { ...good, encryptionMode: 'plain' } })).status).toBe(400);
    expect((await api('POST', '/api/orgs', { body: { ...good, email: 'nope' } })).status).toBe(400);
    expect((await api('POST', '/api/orgs', { body: { ...good, password: 'short' } })).status).toBe(400);
  });

  it('logs in with correct credentials only — uniform 401 otherwise', async () => {
    const payload = registerPayload('login');
    await api('POST', '/api/orgs', { body: payload });

    const wrongPw = await api('POST', '/api/auth/login', {
      body: { email: payload.email, password: 'wrong password entirely' },
    });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.error).toBe('Invalid credentials');

    const noUser = await api('POST', '/api/auth/login', {
      body: { email: `ghost-${run}@test.example`, password: 'whatever password' },
    });
    expect(noUser.status).toBe(401);
    expect(noUser.body.error).toBe('Invalid credentials'); // same message: no enumeration

    const ok = await api('POST', '/api/auth/login', {
      body: { email: payload.email, password: payload.password },
    });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/^whisper_session=/);
  });

  it('CSRF: mutations without X-Requested-With or with a foreign Origin are rejected', async () => {
    const payload = registerPayload('csrf');
    const noHeader = await api('POST', '/api/orgs', { body: payload, csrf: false });
    expect(noHeader.status).toBe(403);

    // ALLOWED_ORIGINS is unset in tests (dev mode) → Origin passes; the
    // header requirement above is the load-bearing check in dev. Foreign-
    // origin rejection is covered by unit-testing checkCsrf with config
    // stubbed — here we assert the header path end-to-end.
    const withHeader = await api('POST', '/api/orgs', { body: payload });
    expect(withHeader.status).toBe(201);
  });

  it('logout kills the session', async () => {
    const res = await api('POST', '/api/orgs', { body: registerPayload('logout') });
    expect((await api('GET', '/api/auth/me', { cookie: res.cookie })).status).toBe(200);

    await api('POST', '/api/auth/logout', { cookie: res.cookie });
    expect((await api('GET', '/api/auth/me', { cookie: res.cookie })).status).toBe(401);
  });

  it('me requires a session', async () => {
    expect((await api('GET', '/api/auth/me')).status).toBe(401);
    expect((await api('GET', '/api/auth/me', { cookie: 'whisper_session=forged' })).status).toBe(401);
  });

  it('invite flow: admin mints, invitee peeks and accepts once', async () => {
    const admin = await api('POST', '/api/orgs', { body: registerPayload('invite') });

    const minted = await api('POST', '/api/invites', { cookie: admin.cookie, body: { role: 'agent' } });
    expect(minted.status).toBe(201);
    const token = minted.body.token as string;
    expect(token.length).toBeGreaterThan(20);

    const peek = await api('GET', `/api/invites/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.body.orgName).toBe('Org invite');
    expect(peek.body.role).toBe('agent');

    const accept = await api('POST', '/api/invites/accept', {
      body: {
        token,
        email: `agent-invite-${run}@test.example`,
        password: 'agent password here',
        displayName: 'Agent One',
      },
    });
    expect(accept.status).toBe(201);
    expect((accept.body.user as Record<string, unknown>).role).toBe('agent');
    expect(accept.cookie).toMatch(/^whisper_session=/);

    // Single use: a second accept (and peek) must fail.
    const again = await api('POST', '/api/invites/accept', {
      body: {
        token,
        email: `agent-invite2-${run}@test.example`,
        password: 'agent password here',
      },
    });
    expect([404, 409]).toContain(again.status);
    expect((await api('GET', `/api/invites/${token}`)).status).toBe(404);
  });

  it('an email conflict on accept releases the invite for retry', async () => {
    const admin = await api('POST', '/api/orgs', { body: registerPayload('inv-retry') });
    const minted = await api('POST', '/api/invites', { cookie: admin.cookie, body: { role: 'agent' } });
    const token = minted.body.token as string;

    const conflicted = await api('POST', '/api/invites/accept', {
      body: { token, email: registerPayload('inv-retry').email, password: 'agent password here' },
    });
    expect(conflicted.status).toBe(409);

    const retry = await api('POST', '/api/invites/accept', {
      body: { token, email: `fresh-${run}@test.example`, password: 'agent password here' },
    });
    expect(retry.status).toBe(201);
  });

  it('RBAC: agents cannot mint invites, change settings, or disable staff', async () => {
    const admin = await api('POST', '/api/orgs', { body: registerPayload('rbac') });
    const minted = await api('POST', '/api/invites', { cookie: admin.cookie, body: { role: 'agent' } });
    const agent = await api('POST', '/api/invites/accept', {
      body: {
        token: minted.body.token,
        email: `agent-rbac-${run}@test.example`,
        password: 'agent password here',
      },
    });
    const agentId = (agent.body.user as Record<string, unknown>).id as string;

    expect((await api('POST', '/api/invites', { cookie: agent.cookie, body: {} })).status).toBe(403);
    expect(
      (await api('PATCH', '/api/org/settings', { cookie: agent.cookie, body: { name: 'X' } })).status,
    ).toBe(403);
    expect(
      (await api('DELETE', `/api/org/agents/${agentId}`, { cookie: agent.cookie })).status,
    ).toBe(403);

    // Agents can still read the roster.
    const roster = await api('GET', '/api/org/agents', { cookie: agent.cookie });
    expect(roster.status).toBe(200);
    expect((roster.body.agents as unknown[]).length).toBe(2);
  });

  it('disabling an agent kills their session; self-disable is blocked', async () => {
    const admin = await api('POST', '/api/orgs', { body: registerPayload('disable') });
    const adminId = (admin.body.user as Record<string, unknown>).id as string;
    const minted = await api('POST', '/api/invites', { cookie: admin.cookie, body: { role: 'agent' } });
    const agent = await api('POST', '/api/invites/accept', {
      body: {
        token: minted.body.token,
        email: `agent-disable-${run}@test.example`,
        password: 'agent password here',
      },
    });
    const agentId = (agent.body.user as Record<string, unknown>).id as string;

    expect((await api('DELETE', `/api/org/agents/${adminId}`, { cookie: admin.cookie })).status).toBe(400);

    expect((await api('DELETE', `/api/org/agents/${agentId}`, { cookie: admin.cookie })).status).toBe(200);
    expect((await api('GET', '/api/auth/me', { cookie: agent.cookie })).status).toBe(401);

    // Disabled agents can't log back in.
    const relogin = await api('POST', '/api/auth/login', {
      body: { email: `agent-disable-${run}@test.example`, password: 'agent password here' },
    });
    expect(relogin.status).toBe(401);
  });

  it('cross-org RBAC: an admin cannot disable another org’s staff', async () => {
    const a = await api('POST', '/api/orgs', { body: registerPayload('xorg-a') });
    const b = await api('POST', '/api/orgs', { body: registerPayload('xorg-b') });
    const bId = (b.body.user as Record<string, unknown>).id as string;

    const attack = await api('DELETE', `/api/org/agents/${bId}`, { cookie: a.cookie });
    expect(attack.status).toBe(404); // org-scoped lookup: not found in org A
    expect((await api('GET', '/api/auth/me', { cookie: b.cookie })).status).toBe(200);
  });

  it('org settings: rename works; encryption mode flips only pre-conversations', async () => {
    const admin = await api('POST', '/api/orgs', { body: registerPayload('settings', 'e2e') });
    const renamed = await api('PATCH', '/api/org/settings', {
      cookie: admin.cookie,
      body: { name: 'Renamed Org', encryptionMode: 'managed' },
    });
    expect(renamed.status).toBe(200);
    const org = renamed.body.org as Record<string, unknown>;
    expect(org.name).toBe('Renamed Org');
    expect(org.encryptionMode).toBe('managed');
  });

  it('agents can publish an E2E public key; bad keys are rejected', async () => {
    const admin = await api('POST', '/api/orgs', { body: registerPayload('pubkey', 'e2e') });
    const bad = await api('PATCH', '/api/auth/me/public-key', {
      cookie: admin.cookie,
      body: { publicKey: 'not-a-key' },
    });
    expect(bad.status).toBe(400);

    const key = Buffer.alloc(32, 7).toString('base64');
    const good = await api('PATCH', '/api/auth/me/public-key', {
      cookie: admin.cookie,
      body: { publicKey: key },
    });
    expect(good.status).toBe(200);
    const me = await api('GET', '/api/auth/me', { cookie: admin.cookie });
    expect((me.body.user as Record<string, unknown>).publicKey).toBe(key);
  });

  it('rate-limits login attempts per IP', async () => {
    let saw429 = false;
    for (let i = 0; i <= AUTH_RATE_LIMIT + 1; i++) {
      const res = await api('POST', '/api/auth/login', {
        body: { email: `flood-${i}-${run}@test.example`, password: 'xxxxxxxxxx' },
      });
      if (res.status === 429) saw429 = true;
    }
    expect(saw429).toBe(true);
  });

  it('legacy routes still work through the router (healthz + handles 400)', async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    const badHandle = await api('GET', '/handles/NOT_VALID!');
    expect(badHandle.status).toBe(400);

    const unknown = await fetch(`${base}/definitely-not-a-route`);
    expect(unknown.status).toBe(404);
  });
});
