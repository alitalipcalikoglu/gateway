import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { JwtError } from '../jwt-verifier.js';
import { RateLimitUnavailable } from '../rate-limit-client.js';
import { Metrics } from '../metrics.js';
import { TraceContext } from '../trace-context.js';
import { Proxy, ProxyError } from '../proxy.js';
import { RateLimiter } from '../rate-limiter.js';
import { UpstreamPool } from '../upstream-pool.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../route-table.js').RouteTable} RouteTable */
/** @typedef {import('../types.js').Route} Route */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */
/** @typedef {import('fastify').FastifyReply} FastifyReply */

// Stage 7: gateway is the one service with no @atc-web/service-core dependency (a deliberate,
// long-standing choice — see service-core's own test/exports.test.js comment on why a `context`
// subpath was removed rather than ever adopted here). So /v1/info's `version` is read the same
// way service-core's own `readServiceVersion` would, just inlined; `serviceCore` is `null` since
// there genuinely is no such dependency to report a version for.
const GATEWAY_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/**
 * The edge: matches a route, enforces rate limit, CORS, method and authentication, then hands
 * the exchange to {@link Proxy}. Own endpoints: /health, /ready, /metrics, /v1/info.
 */
export class GatewayApi {
  static READY_CACHE_MS = 15_000;
  static RESERVED = new Set(['/health', '/ready', '/metrics', '/v1/info']);

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {RouteTable} deps.routes
   * @param {import('../rate-limit-client.js').RateLimitClient|null} [deps.policies]
   * @param {import('../geo-client.js').GeoClient|null} [deps.geo]
   * @param {import('../jwt-verifier.js').JwtVerifier|null} deps.jwt
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {string|null} [deps.routesRevision]  Stage 9: file mtime + content hash, see `/v1/info`.
   */
  constructor({ config, routes, jwt, logger, policies = null, geo = null, routesRevision = null }) {
    this.policies = policies;
    this.geo = geo;
    this.config = config;
    this.routes = routes;
    this.jwt = jwt;
    this.logger = logger;
    this.routesRevision = routesRevision;
    this.proxy = new Proxy({ serverName: config.serverName, defaultTimeoutMs: config.upstreamTimeoutMs, defaultBodyLimit: config.bodyLimit });
    this.limiter = new RateLimiter();
    this.metrics = new Metrics();
    /** @type {Map<string, UpstreamPool>} */
    this.pools = GatewayApi.#buildPools(routes, config);
    this.readyCache = { at: 0, ok: false, detail: /** @type {Record<string, string>} */ ({}) };
  }

  /**
   * @param {RouteTable} routes
   * @param {Config} config
   * @returns {Map<string, UpstreamPool>}
   */
  static #buildPools(routes, config) {
    return new Map(routes.routes.map((r) => [r.id, new UpstreamPool(r.upstreams, { connectTimeoutMs: config.upstreamConnectTimeoutMs, cooldownMs: config.upstreamCooldownMs, breakerThreshold: config.upstreamBreakerThreshold })]));
  }

  /**
   * Stage 9 atomic reload: builds a brand-new `RouteTable` + pools (already validated by the
   * caller — `Application`'s SIGHUP handler — before this is ever called) and swaps them in with
   * one synchronous assignment. Deliberately does NOT destroy the outgoing pools: an in-flight
   * request holds its own local reference to the `route`/`pool` it already picked (see `#handle`
   * below), completely unaffected by `this.routes`/`this.pools` being reassigned out from under
   * it — destroying the old pools' agents here would forcibly kill those still-in-flight sockets.
   * The old agents' own idle-socket timeout (`connectTimeoutMs`, the same value used to build
   * them) reclaims them shortly after they go idle; only final process shutdown forcibly destroys
   * whatever pools are current at that moment (`destroy()` below).
   * @param {RouteTable} routes
   * @param {string} revision
   */
  applyReload(routes, revision) {
    const pools = GatewayApi.#buildPools(routes, this.config);
    this.routes = routes;
    this.pools = pools;
    this.routesRevision = revision;
  }

  /**
   * Stage 9: a route with no central policy is a process-local guard only — nothing to warn about.
   * A route WITH a policy that is public (no `auth: "user"`), rate-limits by IP and fails open
   * means abuse protection silently disappears the moment the ratelimit service is unavailable —
   * worth an operator's attention at startup, but not a reason to refuse to start.
   * @param {import('../types.js').Logger} log
   */
  #warnFailOpenIp(log) {
    for (const r of this.routes.routes) {
      if (!r.policy || r.auth === 'user' || r.policy.subject !== 'ip' || !r.policy.failOpen) continue;
      log.warn({ route: r.id, subject: r.policy.subject, failOpen: r.policy.failOpen, dependency: 'ratelimit' }, 'public route rate-limited by IP with failOpen:true — abuse protection is lost while ratelimit is unavailable');
    }
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
      // Only when the gateway is told it sits behind something that sets these faithfully
      // (TRUST_PROXY=true, same flag Fastify itself uses for X-Forwarded-*) is an inbound
      // X-Request-Id honoured; anyone else's request id is discarded and a fresh one generated,
      // exactly as for X-Forwarded-For today. Same trust boundary applies to `traceparent` below.
      genReqId: (req) => GatewayApi.#inboundRequestId(req.headers['x-request-id'], config.trustProxy) ?? randomUUID(),
      bodyLimit: Number.MAX_SAFE_INTEGER, // bodies are streamed and limited by the proxy, never buffered
      exposeHeadRoutes: false,
    });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    app.decorateRequest('trace', /** @type {any} */ (null));
    app.addHook('onRequest', async (request) => {
      request.trace = TraceContext.forRequest(/** @type {string|undefined} */ (request.headers.traceparent), config.trustProxy);
    });
    app.setErrorHandler(this.#errorHandler);
    app.addHook('onSend', async (_request, reply) => this.#securityHeaders(reply));
    this.#warnFailOpenIp(app.log);

    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/ready', async (_request, reply) => {
      const ready = await this.#readiness();
      return reply.code(ready.ok ? 200 : 503).send({ status: ready.ok ? 'ok' : 'unavailable', upstreams: ready.detail });
    });
    app.get('/v1/info', { logLevel: 'warn' }, async () => ({
      service: 'gateway',
      version: GATEWAY_VERSION,
      apiVersion: 'v1',
      capabilities: ['jwt-auth', 'rate-limit-policy', 'upstream-health-tracking', 'geo-headers', 'cors', 'trace-propagation'],
      schemaVersion: null,
      serviceCore: null,
      routesRevision: this.routesRevision,
    }));
    app.get('/metrics', async (request, reply) => {
      if (!config.metricsToken) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'metrics disabled' } });
      const given = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!GatewayApi.#equal(given, config.metricsToken)) {
        reply.header('www-authenticate', 'Bearer');
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'invalid metrics token' } });
      }
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return this.metrics.render(this.pools);
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

  /** Printable ASCII, no whitespace or control characters, capped at a sane length. */
  static #REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

  /**
   * @param {string|string[]|undefined} header
   * @param {boolean} trusted
   * @returns {string|undefined}
   */
  static #inboundRequestId(header, trusted) {
    if (!trusted) return undefined;
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && GatewayApi.#REQUEST_ID_PATTERN.test(value) ? value : undefined;
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
    const finish = (/** @type {string} */ routeId, /** @type {number} */ status, /** @type {{ upstream?: string, bytesIn?: number, bytesOut?: number, upstreamMs?: number }} */ extra = {}) => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.metrics.observe(routeId, status, durationMs, extra);
      if (extra.upstreamMs !== undefined) this.metrics.observeUpstreamLatency(routeId, extra.upstreamMs);
      log.info({ route: routeId, method: request.method, path, status, durationMs: Math.round(durationMs * 10) / 10, upstreamMs: extra.upstreamMs !== undefined ? Math.round(extra.upstreamMs * 10) / 10 : undefined, ip: request.ip, upstream: extra.upstream, ua: request.headers['user-agent'], reqId: request.id, traceId: request.trace.traceId }, 'access');
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

    if (route.policy && this.policies) {
      const subject = GatewayApi.#subject(route.policy.subject, request, extra['x-user-id']);
      try {
        const d = await this.policies.check({ policy: route.policy.name, subject, cost: route.policy.cost });
        reply.header('ratelimit-limit', String(d.limit));
        reply.header('ratelimit-remaining', String(d.remaining));
        reply.header('ratelimit-reset', String(Math.max(0, Math.ceil((Date.parse(d.resetAt) - Date.now()) / 1000))));
        if (!d.allowed) {
          this.metrics.gateway.policyDenied += 1;
          if (d.retryAfter !== null) reply.header('retry-after', String(d.retryAfter));
          finish(route.id, 429);
          return reply.code(429).send({ error: { code: d.blocked ? 'BLOCKED' : 'RATE_LIMITED', message: d.blocked ? 'this client is blocked' : 'too many requests' } });
        }
      } catch (err) {
        this.metrics.dependencies.ratelimit += 1;
        const code = err instanceof RateLimitUnavailable ? err.code : 'UNKNOWN';
        log.warn({ route: route.id, policy: route.policy.name, code, err: err instanceof Error ? err.message : String(err), reqId: request.id }, route.policy.failOpen ? 'ratelimit unavailable, failing open' : 'ratelimit unavailable, failing closed');
        if (!route.policy.failOpen) {
          this.metrics.gateway.policyUnavailable += 1;
          reply.header('retry-after', '5');
          finish(route.id, 503);
          return reply.code(503).send({ error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'rate limiting temporarily unavailable' } });
        }
      }
    }
    if (route.geo && this.geo) {
      const g = await this.geo.lookup(request.ip);
      if (g === null && this.geo.stats.errors) this.metrics.dependencies.geo = this.geo.stats.errors;
      extra['x-geo-country'] = g?.country ?? '';
      extra['x-geo-timezone'] = g?.timezone ?? '';
      extra['x-geo-continent'] = g?.continent ?? '';
    }

    const pool = /** @type {UpstreamPool} */ (this.pools.get(route.id));
    reply.header('x-request-id', request.id);
    reply.header('traceparent', request.trace.toString());
    try {
      const r = await this.proxy.forward(request, reply, route, pool, extra, {
        onUpstreamError: (u, err) => {
          this.metrics.upstreamError(route.id);
          log.warn({ route: route.id, upstream: u.origin, err: err.message, reqId: request.id }, 'upstream attempt failed');
        },
        onBreakerTransition: (u, from, to) => {
          this.metrics.breakerTransition(route.id, u.origin, from, to);
          log.warn({ route: route.id, upstream: u.origin, from, to }, 'breaker transition');
        },
      });
      finish(route.id, r.status, { upstream: r.upstream.origin, bytesIn: r.bytesIn, bytesOut: r.bytesOut, upstreamMs: r.upstreamMs });
      return reply;
    } catch (err) {
      const status = err instanceof ProxyError ? err.statusCode : 502;
      finish(route.id, status);
      throw err;
    }
  };

  /**
   * The string the policy counts: the client IP, the authenticated user id, or a hash of the
   * client's bearer token (so third-party API keys are limited without being stored anywhere).
   * @param {'ip'|'user'|'key'} kind
   * @param {FastifyRequest} request
   * @param {string|undefined} userId
   */
  static #subject(kind, request, userId) {
    if (kind === 'user' && userId) return `user:${userId}`;
    if (kind === 'key') {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (token) return `key:${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
    }
    return `ip:${request.ip}`;
  }

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
