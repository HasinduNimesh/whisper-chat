/**
 * Iframe side of the embed bridge (see widget/src/embed.ts for the loader
 * side and the security rationale). The parent's origin arrives in the URL
 * hash the loader itself composed; we send only to that origin and accept
 * only from it.
 */

export interface BridgeInit {
  orgSlug: string;
  token?: string;
  context?: Record<string, unknown>;
}

interface BridgeMessage {
  whisper: 1;
  type: string;
  payload?: unknown;
}

export interface WidgetBootParams {
  orgSlug: string;
  parentOrigin: string;
  primaryColor: string;
}

/** Parse the loader-composed hash. Returns null when opened outside an embed. */
export function parseBootParams(hash: string): WidgetBootParams | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const orgSlug = params.get('org');
  const parent = params.get('parent');
  if (!orgSlug || !parent) return null;
  let parentOrigin: string;
  try {
    parentOrigin = new URL(parent).origin;
  } catch {
    return null;
  }
  return {
    orgSlug,
    parentOrigin,
    primaryColor: params.get('primary') ?? '#00a884',
  };
}

export interface BridgeHandlers {
  onInit: (payload: BridgeInit) => void;
  onIdentify: (token: string) => void;
  onVisibility: (open: boolean) => void;
}

export interface Bridge {
  /** Send a message to the embedding page (origin-pinned). */
  send: (type: string, payload?: unknown) => void;
  dispose: () => void;
}

/** Wire up the message channel and announce readiness to the parent. */
export function connectBridge(parentOrigin: string, handlers: BridgeHandlers): Bridge {
  function onMessage(event: MessageEvent): void {
    if (event.origin !== parentOrigin || event.source !== window.parent) return;
    const msg = event.data as BridgeMessage | undefined;
    if (!msg || msg.whisper !== 1 || typeof msg.type !== 'string') return;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    if (msg.type === 'init' && typeof payload.orgSlug === 'string') {
      handlers.onInit({
        orgSlug: payload.orgSlug,
        token: typeof payload.token === 'string' ? payload.token : undefined,
        context:
          payload.context && typeof payload.context === 'object'
            ? (payload.context as Record<string, unknown>)
            : undefined,
      });
    } else if (msg.type === 'identify' && typeof payload.token === 'string') {
      handlers.onIdentify(payload.token);
    } else if (msg.type === 'visibility') {
      handlers.onVisibility(payload.open === true);
    }
  }

  window.addEventListener('message', onMessage);
  const send = (type: string, payload?: unknown): void => {
    window.parent.postMessage({ whisper: 1, type, payload } satisfies BridgeMessage, parentOrigin);
  };
  send('ready');

  return {
    send,
    dispose: () => window.removeEventListener('message', onMessage),
  };
}
