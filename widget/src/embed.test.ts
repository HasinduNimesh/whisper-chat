/**
 * Loader tests: DOM injection, the postMessage origin-pinning rules (the
 * security-critical part), and teardown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import WhisperChat, { type WhisperChatHandle } from './embed';

const WIDGET_ORIGIN = 'https://chat.example.com';

let handle: WhisperChatHandle | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.innerHTML = '';
});

function initWidget(extra: Record<string, unknown> = {}) {
  handle = WhisperChat.init({ url: WIDGET_ORIGIN, orgSlug: 'acme', ...extra });
  return handle;
}

function fakeMessage(origin: string, data: unknown, source?: MessageEventSource | null) {
  const iframe = document.querySelector('iframe')!;
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      data,
      source: source === undefined ? iframe.contentWindow : source,
    }),
  );
}

describe('WhisperChat.init', () => {
  it('validates config and injects launcher + iframe pointed at the widget origin', () => {
    expect(() => WhisperChat.init({ url: 'javascript:alert(1)', orgSlug: 'x' })).toThrow();
    expect(() => WhisperChat.init({} as never)).toThrow();

    initWidget({ theme: { primaryColor: 'rgb(1, 2, 3)' } });
    const iframe = document.querySelector('iframe')!;
    const button = document.querySelector('button')!;
    expect(iframe.src.startsWith(`${WIDGET_ORIGIN}/widget.html#`)).toBe(true);
    expect(iframe.src).toContain('org=acme');
    expect(iframe.src).not.toContain('token'); // tokens NEVER ride the URL
    expect(iframe.style.display).toBe('none');
    expect(button.style.background).toContain('rgb(1, 2, 3)');
  });

  it('answers the iframe ready handshake with init config (token included)', () => {
    const posted: unknown[] = [];
    initWidget({ token: 'signed-jwt' });
    const iframe = document.querySelector('iframe')!;
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((msg: unknown, target) => {
      posted.push({ msg, target });
    });

    fakeMessage(WIDGET_ORIGIN, { whisper: 1, type: 'ready' });
    expect(posted).toHaveLength(1);
    const { msg, target } = posted[0] as { msg: Record<string, unknown>; target: string };
    expect(target).toBe(WIDGET_ORIGIN); // pinned targetOrigin, never '*'
    expect(msg.type).toBe('init');
    expect((msg.payload as Record<string, unknown>).token).toBe('signed-jwt');
  });

  it('ignores messages from foreign origins and foreign sources', () => {
    const readySpy = vi.fn();
    initWidget()!.on('ready', readySpy);
    const iframe = document.querySelector('iframe')!;
    const postSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    // Right shape, wrong origin.
    fakeMessage('https://evil.example.net', { whisper: 1, type: 'ready' });
    // Right origin, wrong source window.
    fakeMessage(WIDGET_ORIGIN, { whisper: 1, type: 'ready' }, null);
    // Right origin+source, wrong protocol tag.
    fakeMessage(WIDGET_ORIGIN, { type: 'ready' });

    expect(readySpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('open/close toggle the panel and notify the iframe; unread badges show when closed', () => {
    const h = initWidget()!;
    const iframe = document.querySelector<HTMLIFrameElement>('iframe')!;
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});

    fakeMessage(WIDGET_ORIGIN, { whisper: 1, type: 'ready' });
    expect(iframe.style.display).toBe('none');

    h.open();
    expect(iframe.style.display).toBe('block');

    h.close();
    expect(iframe.style.display).toBe('none');

    fakeMessage(WIDGET_ORIGIN, { whisper: 1, type: 'unread', payload: 3 });
    const badge = document.querySelector('button span')!;
    expect(badge.textContent).toBe('3');
    expect((badge as HTMLElement).style.display).toBe('block');
  });

  it('destroy removes every trace from the host page', () => {
    const h = initWidget()!;
    expect(document.querySelector('iframe')).not.toBeNull();
    h.destroy();
    handle = null;
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('button')).toBeNull();
  });
});
