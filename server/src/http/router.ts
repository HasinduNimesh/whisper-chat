/**
 * Tiny path router for node:http — the repo deliberately avoids a framework
 * (see CONTRIBUTING.md). Supports `:param` segments; handlers are async and
 * error-contained: DatabaseRequiredError → 503, anything else → 500.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseRequiredError } from '../db/index.js';
import { sendJson } from './helpers.js';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[]; // ':name' segments capture
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.add('GET', path, handler);
  }
  post(path: string, handler: RouteHandler): this {
    return this.add('POST', path, handler);
  }
  patch(path: string, handler: RouteHandler): this {
    return this.add('PATCH', path, handler);
  }
  delete(path: string, handler: RouteHandler): this {
    return this.add('DELETE', path, handler);
  }

  /**
   * Dispatch a request. Returns true when a route matched (including method
   * mismatches answered with 405), false when the path is unknown to this
   * router — the caller decides what a miss means.
   */
  dispatch(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '').split('?')[0];
    const segments = path.split('/').filter(Boolean);

    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;

      const onError = (err: unknown): void => {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof DatabaseRequiredError) return sendJson(res, 503, { error: err.message });
        console.error(`[http] ${req.method} ${path} failed`, err);
        return sendJson(res, 500, { error: 'Internal error' });
      };
      try {
        Promise.resolve(route.handler(req, res, params)).catch(onError);
      } catch (err) {
        onError(err); // synchronous throw before the first await
      }
      return true;
    }

    if (pathMatched) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    return false;
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(actual[i]);
      } catch {
        return null; // malformed percent-encoding
      }
    } else if (p !== actual[i]) {
      return null;
    }
  }
  return params;
}
