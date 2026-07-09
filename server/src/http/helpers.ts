/** Small HTTP primitives shared by every route (no framework — node:http). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALLOWED_ORIGINS } from '../config.js';

/** Resolve the client IP, honoring X-Forwarded-For when behind a proxy. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser client
  return ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
}

export function setCors(req: IncomingMessage, res: ServerResponse, methods: string): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  }
}

/** CORS for cookie-credentialed /api routes (dashboard). */
export function setCredentialedCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  // Never reflect arbitrary origins with credentials — allow-list only.
  if (typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Vary', 'Origin');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Read+parse a small JSON body. Rejects on malformed JSON or oversized input. */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Malformed JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Minimal Cookie-header parser (we only ever look up one cookie). */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
