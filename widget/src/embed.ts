/**
 * Whisper embeddable chat loader.
 *
 * One <script src=".../embed.js"> on any store page exposes `WhisperChat`.
 * The loader never renders chat UI into the host DOM — it injects a floating
 * launcher button and a sandboxing iframe pointing at the self-hosted
 * Whisper origin, and speaks a small versioned postMessage protocol with it.
 *
 * Security posture:
 * - Both bridge ends pin exact origins: the loader only accepts messages
 *   whose origin is the Whisper origin AND whose source is our iframe; every
 *   outbound postMessage targets that origin explicitly (never '*').
 * - Identity tokens travel parent→iframe via postMessage only — never in
 *   the iframe URL, so they can't leak through referrers, history, or logs.
 * - The host page never sees the visitor secret (it lives in the iframe's
 *   own origin-partitioned storage).
 */

export interface WhisperChatTheme {
  /** Accent color for the launcher + widget header (any CSS color). */
  primaryColor?: string;
  /** Corner for the launcher/panel. Default 'right'. */
  position?: 'right' | 'left';
}

export interface WhisperChatConfig {
  /** Your Whisper web origin, e.g. "https://chat.example.com". */
  url: string;
  /** Your organization's slug (dashboard → Settings). */
  orgSlug: string;
  /**
   * Optional signed identity token minted by YOUR backend (see
   * docs/integrations.md) for logged-in customers / C2C threads.
   * Omit for anonymous visitor chat.
   */
  token?: string;
  /** Extra context shown to agents (ignored when a token carries ctx). */
  context?: Record<string, unknown>;
  theme?: WhisperChatTheme;
  /** Open the panel immediately after load. Default false. */
  autoOpen?: boolean;
}

export type WhisperChatEvent = 'ready' | 'open' | 'close' | 'unread';

export interface WhisperChatHandle {
  open(): void;
  close(): void;
  toggle(): void;
  /** Present (or refresh) a signed identity token after load. */
  identify(token: string): void;
  on(event: WhisperChatEvent, cb: (detail?: unknown) => void): () => void;
  destroy(): void;
}

interface BridgeMessage {
  whisper: 1;
  type: string;
  payload?: unknown;
}

const PANEL_CSS = [
  'position:fixed',
  'bottom:96px',
  'width:min(380px, calc(100vw - 32px))',
  'height:min(600px, calc(100dvh - 120px))',
  'border:0',
  'border-radius:16px',
  'box-shadow:0 12px 48px rgba(0,0,0,.35)',
  'z-index:2147483000',
  'background:#111b21',
  'color-scheme:dark',
].join(';');

const BUTTON_CSS = [
  'position:fixed',
  'bottom:24px',
  'width:56px',
  'height:56px',
  'border:0',
  'border-radius:50%',
  'cursor:pointer',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'box-shadow:0 6px 24px rgba(0,0,0,.3)',
  'z-index:2147483001',
].join(';');

const CHAT_ICON =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const CLOSE_ICON =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function init(config: WhisperChatConfig): WhisperChatHandle {
  if (!config || typeof config.url !== 'string' || typeof config.orgSlug !== 'string') {
    throw new Error('WhisperChat.init: `url` and `orgSlug` are required');
  }
  let widgetOrigin: string;
  try {
    const parsed = new URL(config.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    widgetOrigin = parsed.origin;
  } catch {
    throw new Error('WhisperChat.init: `url` must be an http(s) origin');
  }

  const side = config.theme?.position === 'left' ? 'left' : 'right';
  const primary = config.theme?.primaryColor ?? '#00a884';

  const listeners = new Map<WhisperChatEvent, Set<(detail?: unknown) => void>>();
  function emit(event: WhisperChatEvent, detail?: unknown): void {
    for (const cb of listeners.get(event) ?? []) cb(detail);
  }

  // --- DOM ----------------------------------------------------------------
  const iframe = document.createElement('iframe');
  iframe.title = 'Chat';
  // The iframe URL carries only non-secrets (org slug, look & feel, and our
  // origin so the widget can pin its reply channel). Tokens go via bridge.
  const hash = new URLSearchParams({
    v: '1',
    org: config.orgSlug,
    parent: window.location.origin,
    primary,
  });
  iframe.src = `${widgetOrigin}/widget.html#${hash.toString()}`;
  iframe.style.cssText = `${PANEL_CSS};${side}:16px;display:none`;
  iframe.setAttribute('allow', '');

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Open chat');
  button.style.cssText = `${BUTTON_CSS};${side}:24px;background:${primary}`;
  button.innerHTML = CHAT_ICON;

  const badge = document.createElement('span');
  badge.style.cssText =
    'position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#ef4444;color:#fff;font:600 11px/20px system-ui,sans-serif;text-align:center;padding:0 5px;display:none';
  button.style.position = 'fixed';
  button.appendChild(badge);

  document.body.appendChild(iframe);
  document.body.appendChild(button);

  // --- Bridge ---------------------------------------------------------------
  let ready = false;
  let isOpen = false;
  let destroyed = false;

  function post(type: string, payload?: unknown): void {
    iframe.contentWindow?.postMessage({ whisper: 1, type, payload } satisfies BridgeMessage, widgetOrigin);
  }

  function onMessage(event: MessageEvent): void {
    // Origin pinning: only our widget origin, only our iframe.
    if (event.origin !== widgetOrigin || event.source !== iframe.contentWindow) return;
    const msg = event.data as BridgeMessage | undefined;
    if (!msg || msg.whisper !== 1 || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ready':
        ready = true;
        post('init', {
          orgSlug: config.orgSlug,
          token: config.token,
          context: config.context,
        });
        emit('ready');
        if (config.autoOpen) open();
        break;
      case 'unread': {
        const count = typeof msg.payload === 'number' ? msg.payload : 0;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = count > 0 && !isOpen ? 'block' : 'none';
        emit('unread', count);
        break;
      }
      case 'close-request':
        close();
        break;
    }
  }
  window.addEventListener('message', onMessage);

  function open(): void {
    if (destroyed || isOpen) return;
    isOpen = true;
    iframe.style.display = 'block';
    button.innerHTML = CLOSE_ICON;
    button.appendChild(badge);
    button.setAttribute('aria-label', 'Close chat');
    badge.style.display = 'none';
    post('visibility', { open: true });
    emit('open');
  }

  function close(): void {
    if (destroyed || !isOpen) return;
    isOpen = false;
    iframe.style.display = 'none';
    button.innerHTML = CHAT_ICON;
    button.appendChild(badge);
    button.setAttribute('aria-label', 'Open chat');
    post('visibility', { open: false });
    emit('close');
  }

  button.addEventListener('click', () => (isOpen ? close() : open()));

  return {
    open,
    close,
    toggle: () => (isOpen ? close() : open()),
    identify(token: string): void {
      config.token = token;
      if (ready) post('identify', { token });
    },
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    destroy(): void {
      destroyed = true;
      window.removeEventListener('message', onMessage);
      iframe.remove();
      button.remove();
      listeners.clear();
    },
  };
}

export default { init };
