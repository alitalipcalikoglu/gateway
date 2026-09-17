import { Config } from '../src/config.js';
import { RouteTable } from '../src/route-table.js';

export const SECRET = 'k'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides = {}) {
  return Config.fromEnv({ LOG_LEVEL: 'silent', ROUTES_FILE: '/dev/null', ...overrides });
}

/**
 * Routes document used across tests; upstream origins are patched in per test.
 * @param {Partial<Record<'api'|'files'|'auth', string>>} origins
 * @param {object} [extra]
 */
export function routesDoc(origins, extra = {}) {
  return {
    routes: [
      { id: 'files', pathPrefix: '/files/', upstreams: [origins.files ?? 'http://127.0.0.1:1'], methods: ['GET', 'HEAD'], healthPath: '/health' },
      { id: 'media-api', pathPrefix: '/api/media/', stripPrefix: '/api/media', upstreams: [origins.api ?? 'http://127.0.0.1:1'], auth: 'user', injectApiKey: 'MEDIA_API_KEY', cors: ['https://app.test.local'], bodyLimit: 5000, rateLimit: 1000 },
      { id: 'auth-api', pathPrefix: '/api/auth/', stripPrefix: '/api/auth', upstreams: [origins.auth ?? 'http://127.0.0.1:1'], injectApiKey: 'AUTH_API_KEY', cors: ['*'], methods: ['POST', 'OPTIONS'] },
      { id: 'site', pathPrefix: '/', host: 'shop.test.local', upstreams: [origins.api ?? 'http://127.0.0.1:1'] },
    ],
    jwt: { jwksUrl: 'http://127.0.0.1:1/.well-known/jwks.json', issuer: 'https://auth.test.local', audience: 'shop' },
    ...extra,
  };
}

export const routesEnv = { MEDIA_API_KEY: SECRET, AUTH_API_KEY: 'a'.repeat(40) };

/** @param {Parameters<typeof routesDoc>[0]} origins @param {object} [extra] */
export function testRoutes(origins = {}, extra = {}) {
  return RouteTable.parse(routesDoc(origins, extra), routesEnv);
}

/** Silent pino-compatible logger. */
export const silentLog = /** @type {any} */ (new Proxy({}, {
  get: (_t, prop) => (prop === 'child' ? () => silentLog : () => {}),
}));

/**
 * Pino-compatible logger that records every call, per level, instead of discarding it — for
 * asserting on a specific structured log line (a startup warning, a breaker transition, a reload
 * outcome) without depending on real stdout/stderr.
 * @returns {{ log: any, calls: { level: string, args: unknown[] }[] }}
 */
export function capturingLog() {
  /** @type {{ level: string, args: unknown[] }[] } */
  const calls = [];
  /** @type {any} */
  const log = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'child') return () => log;
      return (/** @type {unknown[]} */ ...args) => calls.push({ level: String(prop), args });
    },
  });
  return { log, calls };
}
