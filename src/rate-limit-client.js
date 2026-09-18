/**
 * Thin client for the ratelimit service's check endpoint. Every failure (network, timeout, 5xx,
 * unknown policy) is thrown as {@link RateLimitUnavailable} so the caller can decide to fail open
 * or closed per route.
 */
export class RateLimitUnavailable extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'RateLimitUnavailable';
    this.code = code;
  }
}

/**
 * @typedef {{ allowed: boolean, blocked: boolean, limit: number, remaining: number, resetAt: string, retryAfter: number|null }} Decision
 */
export class RateLimitClient {
  /** @param {{ url: string, apiKey: string, timeoutMs: number, fetch?: typeof fetch }} o */
  constructor({ url, apiKey, timeoutMs, fetch: fetchImpl = fetch }) {
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  /**
   * @param {{ policy: string, subject: string, cost: number }} check
   * @param {Record<string, string>} [headers] Extra headers for this one call — gateway's own
   *   call site attaches its trace-propagation headers here (ratelimit is a fixed, trusted
   *   internal platform dependency, unlike an operator-configured proxy target); never set
   *   implicitly by this class itself.
   * @returns {Promise<Decision>}
   */
  async check(check, headers = {}) {
    let res;
    try {
      res = await this.fetch(`${this.url}/v1/check`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(check),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RateLimitUnavailable(err instanceof Error ? err.message : String(err), 'UNREACHABLE');
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new RateLimitUnavailable(`ratelimit answered ${res.status}: ${text}`, res.status === 404 ? 'POLICY_NOT_FOUND' : res.status === 401 || res.status === 403 ? 'KEY_REJECTED' : 'UPSTREAM_ERROR');
    }
    const d = /** @type {Decision} */ (await res.json());
    if (typeof d.allowed !== 'boolean') throw new RateLimitUnavailable('ratelimit answered without a decision', 'BAD_RESPONSE');
    return d;
  }
}
