export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validated process configuration (routes live in a separate file, see RouteTable). */
export class Config {
  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.routesFile = v.routesFile;
    this.rateLimitMax = v.rateLimitMax;
    this.bodyLimit = v.bodyLimit;
    this.upstreamTimeoutMs = v.upstreamTimeoutMs;
    this.upstreamConnectTimeoutMs = v.upstreamConnectTimeoutMs;
    this.upstreamCooldownMs = v.upstreamCooldownMs;
    this.metricsToken = v.metricsToken;
    this.hstsMaxAge = v.hstsMaxAge;
    this.serverName = v.serverName;
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);
    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');
    const metricsToken = r.optional('METRICS_TOKEN') || null;
    if (metricsToken && metricsToken.length < 32) throw new ConfigError('METRICS_TOKEN must be at least 32 characters');
    const serverName = r.optional('SERVER_NAME') || 'atc-gateway';
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(serverName)) throw new ConfigError('SERVER_NAME must match [A-Za-z0-9._-]{1,40}');
    return new Config({
      port: r.integer('PORT', 3000, { min: 1, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      routesFile: r.optional('ROUTES_FILE') || './routes.json',
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 300, { min: 1 }),
      bodyLimit: r.integer('BODY_LIMIT', 1_048_576, { min: 1_024 }),
      upstreamTimeoutMs: r.integer('UPSTREAM_TIMEOUT_MS', 30_000, { min: 1_000 }),
      upstreamConnectTimeoutMs: r.integer('UPSTREAM_CONNECT_TIMEOUT_MS', 5_000, { min: 100 }),
      upstreamCooldownMs: r.integer('UPSTREAM_COOLDOWN_MS', 10_000, { min: 0 }),
      metricsToken,
      hstsMaxAge: r.integer('HSTS_MAX_AGE', certPath ? 31_536_000 : 0, { min: 0 }),
      serverName,
    });
  }
}

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }
}
