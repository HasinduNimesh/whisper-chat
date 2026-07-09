/**
 * Dashboard unit tests: API wrapper contract (credentials + CSRF header,
 * error normalization), store auth transitions, and XSS-inertness of the
 * shared chat log renderer.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { useInboxStore } from './useInboxStore';
import { ChatLog } from '../components/ChatLog';

/** Minimal WebSocket stub so store code paths that open sockets don't blow up. */
class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  constructor(public url: string) {}
  send(): void {}
  close(): void {}
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api()', () => {
  it('sends credentials and the CSRF header, returns parsed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await api<{ ok: boolean }>('POST', '/api/auth/logout');
    expect(out.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/logout');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('fetch');
  });

  it('normalizes server errors to ApiError with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Invalid credentials' })));
    await expect(api('POST', '/api/auth/login', {})).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
    });
  });

  it('maps network failure to status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const err = await api('GET', '/api/auth/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });
});

describe('useInboxStore auth transitions', () => {
  it('loadMe → anon when the session is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Not signed in' })));
    await useInboxStore.getState().loadMe();
    expect(useInboxStore.getState().status).toBe('anon');
    expect(useInboxStore.getState().user).toBeNull();
  });

  it('failed login records the server message and stays anon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Invalid credentials' })));
    const ok = await useInboxStore.getState().login('a@b.c', 'wrong-password');
    expect(ok).toBe(false);
    expect(useInboxStore.getState().status).toBe('anon');
    expect(useInboxStore.getState().authError).toBe('Invalid credentials');
  });

  it('successful login (managed org) lands authed with user + org', async () => {
    const me = {
      user: { id: 'u1', email: 'a@b.c', displayName: 'Sam', role: 'admin', publicKey: null },
      org: { id: 'o1', name: 'Acme', slug: 'acme', encryptionMode: 'managed' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes('/api/auth/login')
            ? jsonResponse(200, me)
            : jsonResponse(200, { conversations: [] }),
        ),
      ),
    );
    const ok = await useInboxStore.getState().login('a@b.c', 'correct password');
    expect(ok).toBe(true);
    expect(useInboxStore.getState().status).toBe('authed');
    expect(useInboxStore.getState().org?.encryptionMode).toBe('managed');
    expect(useInboxStore.getState().identity).toBeNull(); // no keys in managed mode
  });
});

describe('ChatLog rendering', () => {
  it('renders hostile message text as inert text (no HTML injection)', () => {
    const payload = '<img src=x onerror="window.__pwned=true"><script>window.__pwned=true</script>';
    render(
      <ChatLog
        messages={[
          {
            id: '1',
            mine: false,
            fromKey: 'p1',
            fromName: '<b>Attacker</b>',
            text: payload,
            sentAt: Date.now(),
          },
        ]}
      />,
    );
    // The literal markup is visible as text…
    expect(screen.getByText(payload)).toBeInTheDocument();
    // …and never became real elements or executed.
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
