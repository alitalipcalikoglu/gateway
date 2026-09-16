/**
 * In-memory fixed-window rate limiter keyed by client. Windows are one minute; counters are
 * swept lazily so memory stays bounded by the number of active clients.
 */
export class RateLimiter {
  static WINDOW_MS = 60_000;

  constructor() {
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.buckets = new Map();
    this.lastSweep = 0;
  }

  /**
   * @param {string} key
   * @param {number} max
   * @param {number} [now]
   * @returns {{ allowed: boolean, remaining: number, resetAt: number, retryAfterSec: number }}
   */
  hit(key, max, now = Date.now()) {
    this.#sweep(now);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + RateLimiter.WINDOW_MS };
      this.buckets.set(key, b);
    }
    b.count += 1;
    const allowed = b.count <= max;
    return { allowed, remaining: Math.max(0, max - b.count), resetAt: b.resetAt, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }

  /** @param {number} now */
  #sweep(now) {
    if (now - this.lastSweep < RateLimiter.WINDOW_MS) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }

  get size() {
    return this.buckets.size;
  }
}
