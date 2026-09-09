import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AppError } from './errors';
import { createLogger, type Logger } from './logger';

export interface RequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingMessage['headers'];
  raw: IncomingMessage;
  response: ServerResponse;
}

export type RouteHandler = (context: RequestContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** Marker returned by a handler that already wrote the response itself. */
export const RESPONSE_HANDLED = Symbol('response-handled');

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new AppError('payload_too_large', 'Request body is too large', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return undefined;
  const contentType = String(request.headers['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new AppError('invalid_json', 'Request body is not valid JSON', 400);
    }
  }
  return raw;
}

/**
 * Minimal HTTP router. The services expose small, explicit APIs, so a tiny
 * router keeps the dependency surface small and the behaviour obvious.
 */
export class HttpRouter {
  private readonly routes: Route[] = [];
  private readonly logger: Logger;
  private readonly serviceName: string;

  constructor(serviceName: string, logger?: Logger) {
    this.serviceName = serviceName;
    this.logger = logger ?? createLogger(serviceName);
  }

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }
  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }
  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index++) {
        const segment = route.segments[index]!;
        const value = parts[index]!;
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(value);
        else if (segment !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = (request.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      response.writeHead(204, corsHeaders()).end();
      return;
    }

    const matched = this.match(method, url.pathname);
    if (!matched) {
      this.send(response, 404, { error: { code: 'not_found', message: `No route for ${method} ${url.pathname}` } });
      return;
    }

    try {
      const body = await readBody(request);
      const result = await matched.route.handler({
        method,
        path: url.pathname,
        params: matched.params,
        query: url.searchParams,
        body,
        headers: request.headers,
        raw: request,
        response,
      });
      if (result === RESPONSE_HANDLED) return;
      this.send(response, method === 'POST' ? 201 : 200, result ?? { ok: true });
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const payload =
        error instanceof AppError
          ? { error: error.toJSON() }
          : { error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } };
      if (status >= 500) this.logger.error('request failed', { path: url.pathname, error });
      else this.logger.warn('request rejected', { path: url.pathname, status });
      this.send(response, status, payload);
    } finally {
      this.logger.debug('request', { method, path: url.pathname, durationMs: Date.now() - started });
    }
  }

  private send(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() });
    response.end(body);
  }

  listen(port: number, onReady?: () => void): Server {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.listen(port, () => {
      this.logger.info(`${this.serviceName} listening`, { port });
      onReady?.();
    });
    return server;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
}
