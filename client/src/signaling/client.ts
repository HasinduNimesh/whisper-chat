/**
 * Typed WebSocket client for the signaling/relay server. Thin wrapper that
 * serialises ClientMessage and dispatches incoming ServerMessage to handlers.
 */
import type { ClientMessage, ServerMessage } from '@private-chat/shared';

export type ServerMessageHandler = (msg: ServerMessage) => void;

export interface SignalingHandlers {
  onMessage: ServerMessageHandler;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers: SignalingHandlers;
  private queue: ClientMessage[] = [];

  constructor(url: string, handlers: SignalingHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      // Flush anything queued before the socket opened.
      for (const msg of this.queue) ws.send(JSON.stringify(msg));
      this.queue = [];
      this.handlers.onOpen?.();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        this.handlers.onMessage(msg);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => this.handlers.onClose?.();
    ws.onerror = (err) => this.handlers.onError?.(err);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

/** Resolve the signaling server URL (override with VITE_SIGNALING_URL). */
export function signalingUrl(): string {
  const fromEnv = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (fromEnv) return fromEnv;
  // Same-origin: the Vite dev server proxies /signaling to the ws backend, so we
  // inherit the page's host + scheme (wss:// when served over HTTPS on the LAN).
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/signaling`;
}
