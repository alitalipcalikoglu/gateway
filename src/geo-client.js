/**
 * Country and time zone for a client address from the geo service, cached per address. Misses
 * and failures are cached briefly so an outage costs one request per address per minute at most.
 * Never throws: an unknown or unreachable result is `null`.
 */
export class GeoClient {
  static MAX_CACHE = 20_000;
  static ERROR_TTL_MS = 60_000;

  /** @param {{ url: string, apiKey: string, cacheSec: number, timeoutMs: number, fetch?: typeof fetch, now?: () => number }} o */
  constructor({ url, apiKey, cacheSec, timeoutMs, fetch: fetchImpl = fetch, now = Date.now }) {
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.cacheMs = cacheSec * 1000;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    /** @type {Map<string, { value: { country: string|null, timezone: string|null, continent: string|null }|null, expires: number }>} */
    this.cache = new Map();
    this.stats = { hits: 0, lookups: 0, errors: 0 };
  }

  /**
   * @param {string} ip
   * @returns {Promise<{ country: string|null, timezone: string|null, continent: string|null }|null>}
   */
  async lookup(ip) {
    const cached = this.cache.get(ip);
    if (cached && cached.expires > this.now()) { this.stats.hits++; return cached.value; }
    this.stats.lookups++;
    let value = null;
    let ttl = GeoClient.ERROR_TTL_MS;
    try {
      const res = await this.fetch(`${this.url}/v1/ip/${encodeURIComponent(ip)}`, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.ok) {
        const d = /** @type {any} */ (await res.json());
        value = d.kind === 'public' ? { country: d.country?.code ?? null, timezone: d.timezone ?? null, continent: d.continent?.code ?? null } : null;
        ttl = this.cacheMs;
      } else this.stats.errors++;
    } catch {
      this.stats.errors++;
    }
    if (this.cache.size >= GeoClient.MAX_CACHE) this.cache.delete(/** @type {string} */ (this.cache.keys().next().value));
    this.cache.set(ip, { value, expires: this.now() + ttl });
    return value;
  }
}
