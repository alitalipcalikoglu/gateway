import { Transform } from 'node:stream';
import { RouteTable } from './route-table.js';

/** @typedef {import('./types.js').Route} Route */
/** @typedef {import('./upstream-pool.js').UpstreamPool} UpstreamPool */
/** @typedef {import('./upstream-pool.js').Upstream} Upstream */

export class ProxyError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code
   * @param {string} message
   */
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Headers that must not travel end to end (RFC 9110 §7.6.1) plus ones the gateway owns. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const STRIP_FROM_CLIENT = new Set(['host', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'x-client-ip', 'x-client-user-agent', 'via', 'expect']);
const STRIP_FROM_UPSTREAM = new Set(['server', 'x-powered-by']);
const BODYLESS_STATUS = new Set([204, 205, 304]);

/**
 * Streams one HTTP exchange to an upstream: header hygiene, forwarding headers, body size limit,
 * timeout, passive failure marking and a single retry for safe methods.
 */
export class Proxy {
  static RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  static CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']);

  /**
   * @param {{ serverName: string, defaultTimeoutMs: number, defaultBodyLimit: number }} o
   */
  constructor(o) {
    this.serverName = o.serverName;
    this.defaultTimeoutMs = o.defaultTimeoutMs;
    this.defaultBodyLimit = o.defaultBodyLimit;
  }

  /**
   * Build the header set sent upstream.
   * @param {import('fastify').FastifyRequest} request
   * @param {Route} route
   * @param {Upstream} upstream
   * @param {Record<string, string>} extra  Gateway-asserted headers (X-User-*, injected auth).
   * @returns {Record<string, string|string[]>}
   */
  requestHeaders(request, route, upstream, extra) {
    /** @type {Record<string, string|string[]>} */
    const out = {};
    const connectionTokens = new Set((request.headers.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || STRIP_FROM_CLIENT.has(k) || connectionTokens.has(k) || k.startsWith('x-user-') || k.startsWith('x-geo-')) continue;
      if (k === 'authorization' && (route.injectApiKey || route.auth === 'user')) continue;
      out[k] = v;
    }
    const proto = request.protocol;
    out.host = upstream.url.host;
    out['x-forwarded-for'] = request.ip;
    out['x-forwarded-proto'] = proto;
    out['x-forwarded-host'] = request.hostname;
    out['x-real-ip'] = request.ip;
    out['x-client-ip'] = request.ip;
    if (request.headers['user-agent']) out['x-client-user-agent'] = request.headers['user-agent'];
    out['x-request-id'] = request.id;
    out.traceparent = request.trace.toString();
    out.via = `1.1 ${this.serverName}`;
    if (route.injectApiKey) out.authorization = `Bearer ${route.injectApiKey}`;
    Object.assign(out, extra);
    return out;
  }

  /**
   * Response headers to relay to the client.
   * @param {import('node:http').IncomingHttpHeaders} headers
   * @returns {Record<string, string|string[]>}
   */
  responseHeaders(headers) {
    /** @type {Record<string, string|string[]>} */
    const out = {};
    const connectionTokens = new Set((headers.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || STRIP_FROM_UPSTREAM.has(k) || connectionTokens.has(k)) continue;
      out[k] = v;
    }
    out.via = out.via ? `${out.via}, 1.1 ${this.serverName}` : `1.1 ${this.serverName}`;
    return out;
  }

  /**
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {Route} route
   * @param {UpstreamPool} pool
   * @param {Record<string, string>} extraHeaders
   * @param {{ onUpstreamError: (u: Upstream, err: Error) => void }} hooks
   * @returns {Promise<{ upstream: Upstream, status: number, bytesIn: number, bytesOut: number }>}
   */
  async forward(request, reply, route, pool, extraHeaders, hooks) {
    const method = request.method;
    const hasBody = !(method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'DELETE') || request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined;
    const bodyLimit = route.bodyLimit ?? this.defaultBodyLimit;
    const declared = Number(request.headers['content-length'] ?? 0);
    if (hasBody && declared > bodyLimit) throw new ProxyError(413, 'TOO_LARGE', `request body exceeds ${bodyLimit} bytes`);
    const timeoutMs = route.timeoutMs ?? this.defaultTimeoutMs;
    const path = RouteTable.rewrite(route, request.url.split('?')[0]) + (request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '');

    /** @type {Upstream[]} */
    const tried = [];
    for (;;) {
      const upstream = pool.next({ exclude: tried });
      if (!upstream) throw new ProxyError(503, 'NO_UPSTREAM', 'no upstream available');
      tried.push(upstream);
      try {
        return await this.#attempt(request, reply, route, upstream, path, extraHeaders, { hasBody, bodyLimit, timeoutMs });
      } catch (err) {
        const e = /** @type {ProxyError & { responded?: boolean, bodyStarted?: boolean }} */ (err);
        if (e instanceof ProxyError && e.code !== 'UPSTREAM_UNREACHABLE' && e.code !== 'UPSTREAM_TIMEOUT') throw e;
        hooks.onUpstreamError(upstream, e);
        pool.fail(upstream);
        const retryable = Proxy.RETRY_METHODS.has(method) && !e.bodyStarted && !e.responded && tried.length < pool.upstreams.length;
        if (!retryable) throw e instanceof ProxyError ? e : new ProxyError(502, 'UPSTREAM_UNREACHABLE', 'upstream unreachable');
      }
    }
  }

  /**
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {Route} route
   * @param {Upstream} upstream
   * @param {string} path
   * @param {Record<string, string>} extraHeaders
   * @param {{ hasBody: boolean, bodyLimit: number, timeoutMs: number }} o
   * @returns {Promise<{ upstream: Upstream, status: number, bytesIn: number, bytesOut: number }>}
   */
  #attempt(request, reply, route, upstream, path, extraHeaders, { hasBody, bodyLimit, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let bytesIn = 0;
      let settled = false;
      let bodyStarted = false;
      const fail = (/** @type {ProxyError & { bodyStarted?: boolean }} */ err) => {
        if (settled) return;
        settled = true;
        err.bodyStarted = bodyStarted;
        reject(err);
      };
      const req = upstream.client.request({
        protocol: upstream.url.protocol,
        hostname: upstream.url.hostname,
        port: upstream.url.port || (upstream.tls ? 443 : 80),
        method: request.method,
        path,
        headers: this.requestHeaders(request, route, upstream, extraHeaders),
        agent: upstream.agent,
        setHost: false,
      });
      const timer = setTimeout(() => {
        req.destroy(new ProxyError(504, 'UPSTREAM_TIMEOUT', `upstream did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      req.on('error', (err) => {
        clearTimeout(timer);
        if (err instanceof ProxyError) return fail(err);
        const code = /** @type {{ code?: string }} */ (err).code ?? '';
        const unreachable = Proxy.CONNECT_ERRORS.has(code) || /socket hang up/i.test(err.message);
        fail(new ProxyError(502, unreachable ? 'UPSTREAM_UNREACHABLE' : 'UPSTREAM_ERROR', `upstream error: ${err.message}`));
      });

      req.on('response', (res) => {
        clearTimeout(timer);
        if (settled) return res.destroy();
        settled = true;
        upstream.markUp();
        const status = res.statusCode ?? 502;
        reply.code(status).headers(this.responseHeaders(res.headers));
        let bytesOut = 0;
        const finish = () => resolve({ upstream, status, bytesIn, bytesOut });
        if (request.method === 'HEAD' || BODYLESS_STATUS.has(status)) {
          res.resume();
          reply.send();
          return finish();
        }
        const counter = new Transform({ transform(chunk, _e, cb) { bytesOut += chunk.length; cb(null, chunk); } });
        res.on('error', () => counter.destroy());
        res.on('end', finish);
        request.raw.on('close', () => { if (!res.complete) res.destroy(); });
        reply.send(res.pipe(counter));
      });

      if (!hasBody) return req.end();
      const meter = new Transform({
        transform(chunk, _e, cb) {
          bodyStarted = true;
          bytesIn += chunk.length;
          if (bytesIn > bodyLimit) return cb(new ProxyError(413, 'TOO_LARGE', `request body exceeds ${bodyLimit} bytes`));
          cb(null, chunk);
        },
      });
      meter.on('error', (err) => {
        req.destroy();
        fail(err instanceof ProxyError ? err : new ProxyError(400, 'BODY_ERROR', `request body error: ${err.message}`));
      });
      request.raw.on('error', (err) => meter.destroy(err));
      request.raw.pipe(meter).pipe(req);
    });
  }
}
