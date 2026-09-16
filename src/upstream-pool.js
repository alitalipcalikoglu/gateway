import http from 'node:http';
import https from 'node:https';

/**
 * One upstream origin with a keep-alive agent and passive health state.
 */
export class Upstream {
  /**
   * @param {string} origin
   * @param {{ connectTimeoutMs: number }} o
   */
  constructor(origin, { connectTimeoutMs }) {
    this.origin = origin;
    this.url = new URL(origin);
    this.tls = this.url.protocol === 'https:';
    const AgentClass = this.tls ? https.Agent : http.Agent;
    this.agent = new AgentClass({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32, timeout: connectTimeoutMs, scheduling: 'lifo' });
    /** Epoch ms until which this upstream is skipped. */
    this.downUntil = 0;
    this.failures = 0;
  }

  get client() {
    return this.tls ? https : http;
  }

  /** @param {number} [now] */
  healthy(now = Date.now()) {
    return this.downUntil <= now;
  }

  /**
   * @param {number} cooldownMs
   * @param {number} [now]
   */
  markDown(cooldownMs, now = Date.now()) {
    this.failures += 1;
    this.downUntil = now + cooldownMs;
  }

  markUp() {
    this.failures = 0;
    this.downUntil = 0;
  }

  destroy() {
    this.agent.destroy();
  }
}

/**
 * Round-robin over the upstreams of one route, skipping those in cooldown. When every upstream
 * is down the pool still returns one so a request gets a real answer instead of a guess.
 */
export class UpstreamPool {
  /**
   * @param {string[]} origins
   * @param {{ connectTimeoutMs: number, cooldownMs: number }} o
   */
  constructor(origins, o) {
    this.upstreams = origins.map((origin) => new Upstream(origin, o));
    this.cooldownMs = o.cooldownMs;
    this.cursor = 0;
  }

  /**
   * @param {{ exclude?: Upstream[], now?: number }} [o]
   * @returns {Upstream|undefined}
   */
  next({ exclude = [], now = Date.now() } = {}) {
    const n = this.upstreams.length;
    let fallback;
    for (let i = 0; i < n; i++) {
      const u = this.upstreams[(this.cursor + i) % n];
      if (exclude.includes(u)) continue;
      if (u.healthy(now)) {
        this.cursor = (this.cursor + i + 1) % n;
        return u;
      }
      fallback ??= u;
    }
    if (fallback) this.cursor = (this.cursor + 1) % n;
    return fallback;
  }

  /** @param {Upstream} u */
  fail(u) {
    u.markDown(this.cooldownMs);
  }

  destroy() {
    for (const u of this.upstreams) u.destroy();
  }
}
