import http from 'node:http';
import https from 'node:https';

/** @typedef {{ from: BreakerState, to: BreakerState }} Transition */
/** @typedef {'closed'|'open'|'half-open'} BreakerState */

/**
 * One upstream origin with a keep-alive agent and a circuit breaker (Stage 9): closed (serving
 * normally, counting consecutive failures), open (skipped for `cooldownMs`, one exception below),
 * half-open (cooldown elapsed, exactly one probe request is let through — everyone else keeps
 * treating it as unavailable until that probe settles). `now` is always caller-supplied (from
 * `Date.now()` at the call site, never read internally) so tests can drive the state machine with
 * an injected clock instead of real timers.
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
    /** @type {BreakerState} */
    this.state = 'closed';
    /** Epoch ms until which an `open` upstream is skipped (meaningless once `closed`). */
    this.downUntil = 0;
    /** Consecutive failures while `closed`; irrelevant once `open`/`half-open`. */
    this.failures = 0;
  }

  get client() {
    return this.tls ? https : http;
  }

  /**
   * `next()`'s cheapest check: usable without any special handling, i.e. genuinely healthy.
   * `half-open` is deliberately excluded — it is usable only via {@link claimProbe} or as the
   * last-resort "try anyway" fallback, never as an ordinary pick.
   */
  isClosed() {
    return this.state === 'closed';
  }

  /**
   * Claims the single half-open probe slot, if this upstream is `open` and its cooldown has
   * elapsed. Synchronous and side-effecting on success — the FIRST caller to observe this wins
   * the transition; every other concurrent caller sees `state === 'half-open'` already and this
   * returns `null` for them (no second probe, per the breaker's single-probe invariant).
   * @param {number} now
   * @returns {Transition|null}
   */
  claimProbe(now) {
    if (this.state !== 'open' || now < this.downUntil) return null;
    this.state = 'half-open';
    return { from: 'open', to: 'half-open' };
  }

  /**
   * A successful attempt: always closes the breaker and clears its failure count, whether this
   * was the designated half-open probe or an ordinary closed-state request (idempotent either way).
   * @returns {Transition|null}
   */
  recordSuccess() {
    const from = this.state;
    this.failures = 0;
    this.downUntil = 0;
    this.state = 'closed';
    return from === 'closed' ? null : { from, to: 'closed' };
  }

  /**
   * A failed attempt.
   * - `half-open` (the probe failed, or a ride-along fallback attempt failed while a probe was
   *   pending): → `open`, cooldown restarts, per the breaker's "probe failure re-opens" rule.
   * - `closed`: counts toward `threshold`; opens once reached.
   * - `open` already: no-op transition-wise (still counts the failure for visibility).
   * @param {number} threshold
   * @param {number} cooldownMs
   * @param {number} now
   * @returns {Transition|null}
   */
  recordFailure(threshold, cooldownMs, now) {
    const from = this.state;
    this.failures += 1;
    if (from === 'half-open') {
      this.state = 'open';
      this.downUntil = now + cooldownMs;
      return { from, to: 'open' };
    }
    if (from === 'closed' && this.failures >= threshold) {
      this.state = 'open';
      this.downUntil = now + cooldownMs;
      return { from, to: 'open' };
    }
    return null;
  }

  destroy() {
    this.agent.destroy();
  }
}

/**
 * Round-robin over the upstreams of one route, breaker-aware (Stage 9). Selection order:
 * 1. an ordinary `closed` upstream — ordinary healthy traffic.
 * 2. failing that, an `open` upstream whose cooldown just elapsed — claims it as the one
 *    half-open probe.
 * 3. failing that too (every upstream is `open` and either still cooling down or already has a
 *    probe in flight) — the same deterministic "try anyway" fallback as before Stage 9: return one
 *    anyway so a request always gets a real answer instead of a guess, never a manufactured
 *    deadlock. This ride-along attempt does NOT claim a second probe and does not otherwise
 *    disturb the breaker's bookkeeping beyond its own eventual `fail`/`succeed` call.
 */
export class UpstreamPool {
  /**
   * @param {string[]} origins
   * @param {{ connectTimeoutMs: number, cooldownMs: number, breakerThreshold: number }} o
   */
  constructor(origins, o) {
    this.upstreams = origins.map((origin) => new Upstream(origin, o));
    this.cooldownMs = o.cooldownMs;
    this.breakerThreshold = o.breakerThreshold;
    this.cursor = 0;
  }

  /**
   * @param {{ exclude?: Upstream[], now?: number, onTransition?: (u: Upstream, t: Transition) => void }} [o]
   * @returns {Upstream|undefined}
   */
  next({ exclude = [], now = Date.now(), onTransition } = {}) {
    const n = this.upstreams.length;
    // Pass 1: an ordinary closed (healthy) upstream.
    for (let i = 0; i < n; i++) {
      const u = this.upstreams[(this.cursor + i) % n];
      if (exclude.includes(u)) continue;
      if (u.isClosed()) {
        this.cursor = (this.cursor + i + 1) % n;
        return u;
      }
    }
    // Pass 2: claim the single half-open probe on the first eligible (cooldown-elapsed, not
    // already probing) open upstream.
    for (let i = 0; i < n; i++) {
      const u = this.upstreams[(this.cursor + i) % n];
      if (exclude.includes(u)) continue;
      const transition = u.claimProbe(now);
      if (transition) {
        onTransition?.(u, transition);
        this.cursor = (this.cursor + i + 1) % n;
        return u;
      }
    }
    // Pass 3: all down (still cooling down, or their one probe is already in flight) — deterministic
    // fallback so the request always gets a real attempt, never a manufactured deadlock.
    for (let i = 0; i < n; i++) {
      const u = this.upstreams[(this.cursor + i) % n];
      if (exclude.includes(u)) continue;
      this.cursor = (this.cursor + 1) % n;
      return u;
    }
    return undefined;
  }

  /**
   * @param {Upstream} u
   * @param {{ now?: number, onTransition?: (u: Upstream, t: Transition) => void }} [o]
   */
  fail(u, { now = Date.now(), onTransition } = {}) {
    const t = u.recordFailure(this.breakerThreshold, this.cooldownMs, now);
    if (t) onTransition?.(u, t);
  }

  /**
   * @param {Upstream} u
   * @param {{ onTransition?: (u: Upstream, t: Transition) => void }} [o]
   */
  succeed(u, { onTransition } = {}) {
    const t = u.recordSuccess();
    if (t) onTransition?.(u, t);
  }

  destroy() {
    for (const u of this.upstreams) u.destroy();
  }
}
