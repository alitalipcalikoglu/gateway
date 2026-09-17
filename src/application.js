import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Config, ConfigError } from './config.js';
import { GeoClient } from './geo-client.js';
import { GatewayApi } from './http/gateway-api.js';
import { RateLimitClient } from './rate-limit-client.js';
import { JwtVerifier } from './jwt-verifier.js';
import { RouteTable } from './route-table.js';

/**
 * Deterministic, secret-free identity for the routes file as currently loaded: mtime plus a
 * content hash of the exact bytes parsed (never a resolved `injectApiKey` secret — those live in
 * `process.env`, never in the file itself). Changes whenever the file's content OR its mtime
 * changes; a failed reload never calls this, so a bad file never moves the revision forward.
 * @param {string} path
 */
function routesRevision(path) {
  const raw = readFileSync(path);
  const { mtimeMs } = statSync(path);
  return `${mtimeMs}-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

/** Composition root: config, routes, JWT verifier, HTTP edge, lifecycle. */
export class Application {
  /**
   * @param {Config} config
   * @param {RouteTable} routes
   * @param {string|null} [revision]
   */
  constructor(config, routes, revision = null) {
    this.config = config;
    this.routes = routes;
    this.jwt = routes.jwt ? new JwtVerifier(routes.jwt) : null;
    this.policies = config.ratelimit ? new RateLimitClient(config.ratelimit) : null;
    this.geo = config.geo ? new GeoClient(config.geo) : null;
    Application.#checkIntegrations(config, routes, this.policies, this.geo);
    this.api = new GatewayApi({ config, routes, jwt: this.jwt, policies: this.policies, geo: this.geo, routesRevision: revision });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    this.shuttingDown = false;
    /** Stage 9: serializes SIGHUP — a reload in progress coalesces a second signal into one more pass, never runs two at once. */
    this.reloading = false;
    this.reloadPending = false;
  }

  /**
   * Shared between startup and every SIGHUP reload, so a routes.json that newly needs an
   * integration is refused exactly the same way whether it's the first load or a live reload.
   * @param {Config} config
   * @param {RouteTable} routes
   * @param {RateLimitClient|null} policies
   * @param {GeoClient|null} geo
   */
  static #checkIntegrations(config, routes, policies, geo) {
    void config;
    if (!policies && routes.routes.some((r) => r.policy)) throw new ConfigError('routes with a policy need RATELIMIT_URL and RATELIMIT_API_KEY');
    if (!geo && routes.routes.some((r) => r.geo)) throw new ConfigError('routes with geo: true need GEO_URL and GEO_API_KEY');
  }

  static fromEnv() {
    try {
      const config = Config.fromEnv();
      return new Application(config, RouteTable.load(config.routesFile), routesRevision(config.routesFile));
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const app = await this.api.build();
    this.app = app;
    this.#installSignalHandlers(app.log);
    await app.listen({ port: this.config.port, host: this.config.host });
    app.log.info({
      tls: this.config.tls !== null,
      routes: this.routes.routes.map((r) => ({ id: r.id, host: r.host, prefix: r.pathPrefix, upstreams: r.upstreams.length, auth: r.auth, injectsKey: r.injectApiKey !== null, policy: r.policy?.name ?? null, geo: r.geo })),
      integrations: { ratelimit: this.policies !== null, geo: this.geo !== null },
      jwt: this.routes.jwt ? { issuer: this.routes.jwt.issuer, audience: this.routes.jwt.audience } : null,
    }, this.config.tls ? 'serving HTTPS' : 'serving plain HTTP');
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

  /** @param {string} reason */
  async shutdown(reason) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = /** @type {import('./types.js').Logger} */ (this.app?.log ?? console);
    log.info({ reason }, 'shutting down');
    const forceExit = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, this.config.upstreamTimeoutMs + 5_000).unref();
    try {
      await this.app?.close();
      this.api.destroy();
      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }

  /**
   * Stage 9: re-read, validate and atomically swap `routes.json` without dropping any in-flight
   * request. A bad file (unreadable, invalid JSON, fails validation, or newly needs an integration
   * that isn't configured) is caught, logged, and changes nothing — the previous `RouteTable` and
   * pools keep serving exactly as before, `routesRevision` unchanged. Never throws, never crashes
   * the process; the only way to see it failed is the structured error log line.
   * @param {import('./types.js').Logger} log
   */
  async #reload(log) {
    try {
      const routes = RouteTable.load(this.config.routesFile);
      Application.#checkIntegrations(this.config, routes, this.policies, this.geo);
      const revision = routesRevision(this.config.routesFile);
      this.api.applyReload(routes, revision);
      this.routes = routes;
      log.info({ revision, routes: routes.routes.length }, 'routes reloaded');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'routes reload failed, keeping the previous configuration');
    }
  }

  /**
   * Public entry point for a reload — what SIGHUP calls, and what a test calls directly instead of
   * sending a real OS signal. One reload runs at a time: a SIGHUP (or call) that arrives while one
   * is already in flight doesn't start a second, overlapping reload (which could race two
   * `RouteTable.load()`s against each other) — it's coalesced into exactly one more pass once the
   * current one finishes. Shutting down always wins: a call during or after shutdown is a no-op.
   * @param {import('./types.js').Logger} [log]
   */
  async reload(log = /** @type {import('./types.js').Logger} */ (this.app?.log ?? console)) {
    if (this.shuttingDown) return;
    if (this.reloading) {
      this.reloadPending = true;
      log.info('reload already in progress, coalescing this SIGHUP into the next pass');
      return;
    }
    this.reloading = true;
    try {
      do {
        this.reloadPending = false;
        await this.#reload(log);
      } while (this.reloadPending && !this.shuttingDown);
    } finally {
      this.reloading = false;
    }
  }

  /** @param {import('./types.js').Logger} log */
  #installSignalHandlers(log) {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGHUP', () => { this.reload(log).catch((err) => log.fatal({ err }, 'SIGHUP handling failed unexpectedly')); });
    process.on('unhandledRejection', (reason) => {
      log.fatal({ err: reason }, 'unhandled rejection');
      this.shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      log.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  }
}
