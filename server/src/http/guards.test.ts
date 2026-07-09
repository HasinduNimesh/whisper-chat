import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Pin the allow-list so the foreign-origin path is exercised regardless of env.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  ALLOWED_ORIGINS: ['https://app.example.com'],
}));

const { checkCsrf } = await import('./guards.js');

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { method: 'POST', url: '/api/x', headers } as unknown as IncomingMessage;
}

function fakeRes() {
  const state = { status: 0 };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      state.status = status;
      return res;
    },
    setHeader() {},
    end() {},
  } as unknown as ServerResponse;
  return { res, state };
}

describe('checkCsrf', () => {
  it('rejects mutations without X-Requested-With', () => {
    const { res, state } = fakeRes();
    expect(checkCsrf(fakeReq({}), res)).toBe(false);
    expect(state.status).toBe(403);
  });

  it('rejects foreign origins', () => {
    const { res, state } = fakeRes();
    const req = fakeReq({ 'x-requested-with': 'fetch', origin: 'https://evil.example.net' });
    expect(checkCsrf(req, res)).toBe(false);
    expect(state.status).toBe(403);
  });

  it('accepts allow-listed origins', () => {
    const { res } = fakeRes();
    const req = fakeReq({ 'x-requested-with': 'fetch', origin: 'https://app.example.com' });
    expect(checkCsrf(req, res)).toBe(true);
  });

  it('accepts same-host origins (single-origin deploys not in the list)', () => {
    const { res } = fakeRes();
    const req = fakeReq({
      'x-requested-with': 'fetch',
      origin: 'https://chat.example.com',
      host: 'chat.example.com',
    });
    expect(checkCsrf(req, res)).toBe(true);
  });

  it('accepts non-browser requests (no Origin) that carry the header', () => {
    const { res } = fakeRes();
    expect(checkCsrf(fakeReq({ 'x-requested-with': 'fetch' }), res)).toBe(true);
  });
});
