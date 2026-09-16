import { Config } from './config.js';
import { GatewayApi } from './http/gateway-api.js';
import { JwtVerifier } from './jwt-verifier.js';
import { RouteTable } from './route-table.js';

/** Composition root: config, routes, JWT verifier, HTTP edge, lifecycle. */
export class Application {
  /**
   * @param {Config} config
   * @param {RouteTable} routes
   */
  constructor(config, routes) {
    this.config = config;
    this.routes = routes;
    this.jwt = routes.jwt ? new JwtVerifier(routes.jwt) : null;
    this.api = new GatewayApi({ config, routes, jwt: this.jwt });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    this.shuttingDown = false;
  }

  static fromEnv() {
    try {
      const config = Config.fromEnv();
      return new Application(config, RouteTable.load(config.routesFile));
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
      routes: this.routes.routes.map((r) => ({ id: r.id, host: r.host, prefix: r.pathPrefix, upstreams: r.upstreams.length, auth: r.auth, injectsKey: r.injectApiKey !== null })),
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

  /** @param {import('./types.js').Logger} log */
  #installSignalHandlers(log) {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
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
