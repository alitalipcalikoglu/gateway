import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { JwtError } from '../jwt-verifier.js';
import { Metrics } from '../metrics.js';
import { Proxy, ProxyError } from '../proxy.js';
import { RateLimiter } from '../rate-limiter.js';
import { UpstreamPool } from '../upstream-pool.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../route-table.js').RouteTable} RouteTable */
/** @typedef {import('../types.js').Route} Route */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */
/** @typedef {import('fastify').FastifyReply} FastifyReply */

/**
 * The edge: matches a route, enforces rate limit, CORS, method and authentication, then hands
 * the exchange to {@link Proxy}. Own endpoints: /health, /ready, /metrics.
 */
export class GatewayApi {
  static READY_CACHE_MS = 15_000;
  static RESERVED = new Set(['/health', '/ready', '/metrics']);

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {RouteTable} deps.routes
   * @param {import('../jwt-verifier.js').JwtVerifier|null} deps.jwt
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, routes, jwt, logger }) {
    this.config = config;
    this.routes = routes;
    this.jwt = jwt;
    this.logger = logger;
    this.proxy = new Proxy({ serverName: config.serverName, defaultTimeoutMs: config.upstreamTimeoutMs, defaultBodyLimit: config.bodyLimit });
    this.limiter = new RateLimiter();
    this.metrics = new Metrics();
    /** @type {Map<string, UpstreamPool>} */
    this.pools = new Map(routes.routes.map((r) => [r.id, new UpstreamPool(r.upstreams, { connectTimeoutMs: config.upstreamConnectTimeoutMs, cooldownMs: config.upstreamCooldownMs })]));
    this.readyCache = { at: 0, ok: false, detail: /** @type {Record<string, string>} */ ({}) };
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      loggerInstance: this.logger,
      logger: this.logger ? undefined : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
      trustProxy: config.trustProxy,
      disableRequestLogging: true,
      requestIdHeader: false,
      genReqId: () => randomUUID(),
      bodyLimit: Number.MAX_SAFE_INTEGER, // bodies are streamed and limited by the proxy, never buffered
      exposeHeadRoutes: false,
    });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    app.setErrorHandler(this.#errorHandler);
    app.addHook('onSend', async (_request, reply) => this.#securityHeaders(reply));

    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/ready', async (_request, reply) => {
      const ready = await this.#readiness();
      return reply.code(ready.ok ? 200 : 503).send({ status: ready.ok ? 'ok' : 'unavailable', upstreams: ready.detail });
    });
    app.get('/metrics', async (request, reply) => {
      if (!config.metricsToken) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'metrics disabled' } });
      const given = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!GatewayApi.#equal(given, config.metricsToken)) {
        reply.header('www-authenticate', 'Bearer');
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'invalid metrics token' } });
      }
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return this.metrics.render();
    });
    app.all('/*', this.#handle);
    app.all('/', this.#handle);
    return app;
  }

  /**
   * @param {string} a
   * @param {string} b
   */
  static #equal(a, b) {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  }

  /** @param {FastifyReply} reply */
  #securityHeaders(reply) {
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (this.config.hstsMaxAge > 0) reply.header('strict-transport-security', `max-age=${this.config.hstsMaxAge}; includeSubDomains`);
    reply.header('server', this.config.serverName);
  }

  /** @type {FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {Error & { statusCode?: number, code?: string }} */ (rawErr);
    if (err instanceof ProxyError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) request.log.error({ err, reqId: request.id }, 'unhandled error');
    return reply.code(status).send({ error: { code: status >= 500 ? 'INTERNAL_ERROR' : (err.code ?? 'REQUEST_ERROR'), message: status >= 500 ? 'internal error' : err.message } });
  };

  /**
   * @param {FastifyRequest} request
   * @param {FastifyReply} reply
   */
  #handle = async (request, reply) => {
    const started = process.hrtime.bigint();
    const path = request.url.split('?')[0];
    const route = this.routes.match(request.hostname, path);
    const log = request.log;
    const finish = (/** @type {string} */ routeId, /** @type {number} */ status, /** @type {{ upstream?: string, bytesIn?: number, bytesOut?: number }} */ extra = {}) => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.metrics.observe(routeId, status, durationMs, extra);
      log.info({ route: routeId, method: request.method, path, status, durationMs: Math.round(durationMs * 10) / 10, ip: request.ip, upstream: extra.upstream, ua: request.headers['user-agent'], reqId: request.id }, 'access');
    };

    if (!route) {
      this.metrics.gateway.noRoute += 1;
      finish('-', 404);
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no route' } });
    }

    // CORS preflight is answered here; other requests get the headers on the way out.
    const origin = request.headers.origin;
    const corsOk = route.cors !== null && typeof origin === 'string' && (route.cors.includes('*') || route.cors.includes(origin.toLowerCase()));
    if (corsOk) {
      reply.header('access-control-allow-origin', route.cors?.includes('*') ? '*' : /** @type {string} */ (origin));
      if (!route.cors?.includes('*')) reply.header('vary', 'Origin');
      reply.header('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Location, X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After');
    }
    if (request.method === 'OPTIONS' && route.cors !== null && request.headers['access-control-request-method']) {
      if (corsOk) {
        reply.header('access-control-allow-methods', (route.methods ?? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).join(', '));
        reply.header('access-control-allow-headers', request.headers['access-control-request-headers'] ?? 'Authorization, Content-Type');
        reply.header('access-control-max-age', '600');
      }
      finish(route.id, 204);
      return reply.code(204).send();
    }

    if (route.methods && !route.methods.includes(request.method)) {
      reply.header('allow', route.methods.join(', '));
      finish(route.id, 405);
      return reply.code(405).send({ error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} is not allowed on this route` } });
    }

    const limit = this.limiter.hit(`${route.id}:${request.ip}`, route.rateLimit ?? this.config.rateLimitMax);
    reply.header('x-ratelimit-limit', String(route.rateLimit ?? this.config.rateLimitMax));
    reply.header('x-ratelimit-remaining', String(limit.remaining));
    if (!limit.allowed) {
      this.metrics.gateway.rateLimited += 1;
      reply.header('retry-after', String(limit.retryAfterSec));
      finish(route.id, 429);
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'too many requests' } });
    }

    /** @type {Record<string, string>} */
    const extra = {};
    if (route.auth === 'user') {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      try {
        if (!token || !this.jwt) throw new JwtError('MISSING', 'access token required');
        const claims = await this.jwt.verify(token);
        extra['x-user-id'] = claims.sub;
        extra['x-user-session'] = claims.sid;
        extra['x-user-email'] = claims.email ?? '';
        extra['x-user-email-verified'] = claims.email_verified ? 'true' : 'false';
      } catch (err) {
        const e = err instanceof JwtError ? err : new JwtError('INVALID', 'token invalid');
        if (e.code === 'JWKS_UNAVAILABLE') {
          log.error({ err, reqId: request.id }, 'JWKS unavailable');
          finish(route.id, 503);
          return reply.code(503).send({ error: { code: 'AUTH_UNAVAILABLE', message: 'authentication temporarily unavailable' } });
        }
        this.metrics.gateway.unauthorized += 1;
        reply.header('www-authenticate', `Bearer error="${e.code === 'MISSING' ? 'invalid_request' : 'invalid_token'}"`);
        finish(route.id, 401);
        return reply.code(401).send({ error: { code: e.code === 'MISSING' ? 'UNAUTHORIZED' : e.code, message: e.message } });
      }
    }

    const pool = /** @type {UpstreamPool} */ (this.pools.get(route.id));
    reply.header('x-request-id', request.id);
    try {
      const r = await this.proxy.forward(request, reply, route, pool, extra, {
        onUpstreamError: (u, err) => {
          this.metrics.upstreamError(route.id);
          log.warn({ route: route.id, upstream: u.origin, err: err.message, reqId: request.id }, 'upstream attempt failed');
        },
      });
      finish(route.id, r.status, { upstream: r.upstream.origin, bytesIn: r.bytesIn, bytesOut: r.bytesOut });
      return reply;
    } catch (err) {
      const status = err instanceof ProxyError ? err.statusCode : 502;
      finish(route.id, status);
      throw err;
    }
  };

  /** Every route needs at least one upstream answering its health path. */
  async #readiness() {
    const now = Date.now();
    if (now - this.readyCache.at < GatewayApi.READY_CACHE_MS) return this.readyCache;
    /** @type {Record<string, string>} */
    const detail = {};
    let ok = true;
    await Promise.all(this.routes.routes.map(async (route) => {
      const results = await Promise.all(route.upstreams.map(async (origin) => {
        try {
          const res = await fetch(`${origin}${route.healthPath}`, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
          return res.ok;
        } catch {
          return false;
        }
      }));
      const healthy = results.filter(Boolean).length;
      detail[route.id] = `${healthy}/${route.upstreams.length}`;
      if (healthy === 0) ok = false;
    }));
    this.readyCache = { at: now, ok, detail };
    return this.readyCache;
  }

  destroy() {
    for (const p of this.pools.values()) p.destroy();
  }
}
