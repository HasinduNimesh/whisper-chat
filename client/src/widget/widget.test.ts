/**
 * Iframe-side widget tests: boot-param parsing, bridge origin pinning, and
 * visitor-secret persistence/revalidation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectBridge, parseBootParams } from './bridge';
import { ensureVisitorSession } from './visitorSession';

const PARENT = 'https://store.example';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('parseBootParams', () => {
  it('parses the loader-composed hash', () => {
    const boot = parseBootParams('#v=1&org=acme&parent=https%3A%2F%2Fstore.example&primary=%2300a884');
    expect(boot).toEqual({ orgSlug: 'acme', parentOrigin: PARENT, primaryColor: '#00a884' });
  });

  it('returns null for direct opens or malformed parents', () => {
    expect(parseBootParams('')).toBeNull();
    expect(parseBootParams('#org=acme')).toBeNull();
    expect(parseBootParams('#org=acme&parent=not-a-url')).toBeNull();
  });
});

describe('connectBridge', () => {
  function fakeParentMessage(origin: string, data: unknown, source: MessageEventSource | null) {
    window.dispatchEvent(new MessageEvent('message', { origin, data, source }));
  }

  it('announces ready to the pinned parent origin and dispatches init', () => {
    const posted: Array<{ msg: unknown; target: string }> = [];
    vi.spyOn(window.parent, 'postMessage').mockImplementation(
      (msg: unknown, target: unknown) => void posted.push({ msg, target: String(target) }),
    );
    const onInit = vi.fn();
    const bridge = connectBridge(PARENT, { onInit, onIdentify: vi.fn(), onVisibility: vi.fn() });

    expect(posted).toHaveLength(1);
    expect(posted[0].target).toBe(PARENT); // never '*'
    expect((posted[0].msg as { type: string }).type).toBe('ready');

    fakeParentMessage(PARENT, { whisper: 1, type: 'init', payload: { orgSlug: 'acme', token: 't' } }, window.parent);
    expect(onInit).toHaveBeenCalledWith({ orgSlug: 'acme', token: 't', context: undefined });
    bridge.dispose();
  });

  it('ignores messages from other origins and non-parent sources', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const onInit = vi.fn();
    const onVisibility = vi.fn();
    const bridge = connectBridge(PARENT, { onInit, onIdentify: vi.fn(), onVisibility });

    fakeParentMessage('https://evil.example.net', { whisper: 1, type: 'init', payload: { orgSlug: 'acme' } }, window.parent);
    fakeParentMessage(PARENT, { whisper: 1, type: 'visibility', payload: { open: true } }, null);
    fakeParentMessage(PARENT, { type: 'init', payload: { orgSlug: 'acme' } }, window.parent);

    expect(onInit).not.toHaveBeenCalled();
    expect(onVisibility).not.toHaveBeenCalled();
    bridge.dispose();
  });
});

describe('ensureVisitorSession', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('persists a freshly minted secret and reuses it on the next boot', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(201, { visitorSecret: 's3cret', orgName: 'Acme', encryptionMode: 'managed' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { orgName: 'Acme', encryptionMode: 'managed' }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await ensureVisitorSession('acme');
    expect(first.visitorSecret).toBe('s3cret');

    // Second boot: the stored secret is presented and (no new secret returned) kept.
    const second = await ensureVisitorSession('acme');
    expect(second.visitorSecret).toBe('s3cret');
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(secondBody.visitorSecret).toBe('s3cret');
  });

  it('secrets are scoped per org slug', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(201, { visitorSecret: 'a-secret', orgName: 'A', encryptionMode: 'managed' }),
        )
        .mockResolvedValueOnce(
          jsonResponse(201, { visitorSecret: 'b-secret', orgName: 'B', encryptionMode: 'managed' }),
        ),
    );
    await ensureVisitorSession('org-a');
    await ensureVisitorSession('org-b');
    expect(localStorage.getItem('whisper.widget.visitor.v1.org-a')).toBe('a-secret');
    expect(localStorage.getItem('whisper.widget.visitor.v1.org-b')).toBe('b-secret');
  });

  it('surfaces server errors as exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'Unknown organization' })));
    await expect(ensureVisitorSession('ghost')).rejects.toThrow('Unknown organization');
  });
});
