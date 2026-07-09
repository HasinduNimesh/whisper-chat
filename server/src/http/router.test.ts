import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router } from './router.js';
import { OrgFeaturesUnavailableError } from '../db/pool.js';

function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

function fakeRes() {
  const state = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      state.status = status;
      return res;
    },
    setHeader() {},
    end(body?: string) {
      if (body) state.body += body;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Router', () => {
  it('matches static and :param routes, decoding params', async () => {
    const router = new Router();
    let seen: Record<string, string> = {};
    router.get('/api/things/:id', (_req, res, params) => {
      seen = params;
      res.writeHead(200).end();
    });

    const { res, state } = fakeRes();
    expect(router.dispatch(fakeReq('GET', '/api/things/a%20b?x=1'), res)).toBe(true);
    await tick();
    expect(seen.id).toBe('a b');
    expect(state.status).toBe(200);
  });

  it('returns false on unknown paths and 405 on method mismatch', async () => {
    const router = new Router();
    router.post('/api/only-post', (_req, res) => res.writeHead(201).end());

    const miss = fakeRes();
    expect(router.dispatch(fakeReq('GET', '/nope'), miss.res)).toBe(false);

    const wrongMethod = fakeRes();
    expect(router.dispatch(fakeReq('GET', '/api/only-post'), wrongMethod.res)).toBe(true);
    await tick();
    expect(wrongMethod.state.status).toBe(405);
  });

  it('maps DatabaseRequiredError to 503 and other throws to 500', async () => {
    const router = new Router();
    router.get('/api/needs-db', () => {
      throw new OrgFeaturesUnavailableError();
    });
    router.get('/api/boom', () => {
      throw new Error('kaput');
    });

    const dbless = fakeRes();
    router.dispatch(fakeReq('GET', '/api/needs-db'), dbless.res);
    await tick();
    expect(dbless.state.status).toBe(503);
    expect(dbless.state.body).toContain('DATABASE_URL');

    const boom = fakeRes();
    router.dispatch(fakeReq('GET', '/api/boom'), boom.res);
    await tick();
    expect(boom.state.status).toBe(500);
    expect(boom.state.body).not.toContain('kaput'); // internals never leak
  });
});
