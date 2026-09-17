import http from 'node:http';
import https from 'node:https';

/** @typedef {{ from: BreakerState, to: BreakerState }} Transition */
/** @typedef {'closed'|'open'|'half-open'} BreakerState */

/**
 * What kind of decision-making power a particular attempt has over the breaker (Stage 9.1):
 * - `ordinary`: a plain closed-state pick. Always authoritative — records every success/failure
 *   exactly as it happens, same as before there was a breaker at all.
 * - `probe`: the ONE designated half-open probe for a specific half-open episode (`generation`
 *   pins it to that episode). Authoritative for that episode only — see {@link Upstream#generation}.
 * - `ride-along`: a "try anyway" fallback attempt (Pass 3) sent alongside — or instead of — a
 *   designated probe, purely so a request always gets a real answer. Never authoritative: it may
 *   still surface as ordinary latency/error telemetry, but it can never itself flip the breaker.
 * @typedef {{ kind: 'ordinary' }} OrdinaryAttempt
 * @typedef {{ kind: 'probe', generation: number }} ProbeAttempt
 * @typedef {{ kind: 'ride-along' }} RideAlongAttempt
 * @typedef {OrdinaryAttempt|ProbeAttempt|RideAlongAttempt} Attempt
 */

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
    /**
     * Stage 9.1: bumped every time {@link claimProbe} starts a new half-open episode. A
     * `ProbeAttempt`'s `generation` is only authoritative while it still matches this value — once
     * a NEWER episode has started (this upstream re-opened and was probed again), a straggling
     * result from an older episode is fenced out: it can never resolve a generation that has
     * already moved on. There is no other way for `state` to leave `half-open` except through the
     * matching probe's own `recordSuccess`/`recordFailure`, so a mismatch can only mean "stale".
     */
    this.generation = 0;
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
   * the transition and receives the new episode's `generation`; every other concurrent caller
   * sees `state === 'half-open'` already and this returns `null` for them (no second probe, per
   * the breaker's single-probe invariant).
   * @param {number} now
   * @returns {{ transition: Transition, generation: number }|null}
   */
  claimProbe(now) {
    if (this.state !== 'open' || now < this.downUntil) return null;
    this.state = 'half-open';
    this.generation += 1;
    return { transition: { from: 'open', to: 'half-open' }, generation: this.generation };
  }

  /**
   * A successful attempt: always closes the breaker and clears its failure count, whether this
   * was the designated half-open probe or an ordinary closed-state request (idempotent either way).
   * Callers only reach this for an attempt already confirmed authoritative — see
   * {@link UpstreamPool#succeed}.
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
   * A failed attempt, already confirmed authoritative by the caller — see
   * {@link UpstreamPool#fail}.
   * - `half-open` (the designated probe failed): → `open`, cooldown restarts, per the breaker's
   *   "probe failure re-opens" rule.
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
 * Round-robin over the upstreams of one route, breaker-aware (Stage 9/9.1). Selection order:
 * 1. an ordinary `closed` upstream — ordinary healthy traffic, always authoritative.
 * 2. failing that, an `open` upstream whose cooldown just elapsed — claims it as the one
 *    half-open probe for a brand-new episode; ITS result (and only its result) may resolve that
 *    episode.
 * 3. failing that too (every upstream is `open` and either still cooling down or already has a
 *    probe in flight) — the same deterministic "try anyway" fallback as before Stage 9: return one
 *    anyway so a request always gets a real answer instead of a guess, never a manufactured
 *    deadlock. This is a `ride-along` attempt: it may run, and its latency/error telemetry is
 *    real, but per {@link Upstream}'s ownership model it can never itself decide the breaker's
 *    state — only the matching `probe` (or an `ordinary` closed-state attempt) can.
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
   * @returns {{ upstream: Upstream, attempt: Attempt }|undefined}
   */
  next({ exclude = [], now = Date.now(), onTransition } = {}) {
    const n = this.upstreams.length;
    // Pass 1: an ordinary closed (healthy) upstream.
    for (let i = 0; i < n; i++) {
      const u = this.upstreams[(this.cursor + i) % n];
      if (exclude.includes(u)) continue;
      if (u.isClosed()) {
        this.cursor = (this.cursor + i + 1) % n;
        return { upstream: u, attempt: { kind: 'ordinary' } };
      }
    }
    // Pass 2: claim the single half-open probe on the first eligible (cooldown-elapsed, not
    // already probing) open upstream. This is the ONLY attempt kind carrying decision-making
    // power over this specific half-open episode.
    for (let i = 0; i < n; i++) {
      const u = this.upstreams[(this.cursor + i) % n];
      if (exclude.includes(u)) continue;
      const claim = u.claimProbe(now);
      if (claim) {
        onTransition?.(u, claim.transition);
        this.cursor = (this.cursor + i + 1) % n;
        return { upstream: u, attempt: { kind: 'probe', generation: claim.generation } };
      }
    }
    // Pass 3: all down (still cooling down, or their one probe is already in flight) — deterministic
    // fallback so the request always gets a real attempt, never a manufactured deadlock. Explicitly
    // non-authoritative: see `fail`/`succeed` below.
    for (let i = 0; i < n; i++) {
      const u = this.upstreams[(this.cursor + i) % n];
      if (exclude.includes(u)) continue;
      this.cursor = (this.cursor + 1) % n;
      return { upstream: u, attempt: { kind: 'ride-along' } };
    }
    return undefined;
  }

  /**
   * Records a failed attempt — but only actually mutates breaker state when `attempt` is
   * authoritative for it right now: `ordinary` always is; `probe` is only while its `generation`
   * still matches the upstream's current episode (a stale, superseded probe is silently fenced
   * out — see {@link Upstream#generation}); `ride-along` never is (still worth logging/measuring
   * elsewhere, just never worth letting it flip a breaker it was never the designated decider for).
   * @param {Upstream} u
   * @param {Attempt} attempt
   * @param {{ now?: number, onTransition?: (u: Upstream, t: Transition) => void }} [o]
   */
  fail(u, attempt, { now = Date.now(), onTransition } = {}) {
    if (!UpstreamPool.#authoritative(u, attempt)) return;
    const t = u.recordFailure(this.breakerThreshold, this.cooldownMs, now);
    if (t) onTransition?.(u, t);
  }

  /**
   * Records a successful attempt — same authority rule as {@link fail}.
   * @param {Upstream} u
   * @param {Attempt} attempt
   * @param {{ onTransition?: (u: Upstream, t: Transition) => void }} [o]
   */
  succeed(u, attempt, { onTransition } = {}) {
    if (!UpstreamPool.#authoritative(u, attempt)) return;
    const t = u.recordSuccess();
    if (t) onTransition?.(u, t);
  }

  /**
   * @param {Upstream} u
   * @param {Attempt} attempt
   */
  static #authoritative(u, attempt) {
    if (attempt.kind === 'ride-along') return false;
    if (attempt.kind === 'probe') return u.generation === attempt.generation;
    return true; // 'ordinary'
  }

  destroy() {
    for (const u of this.upstreams) u.destroy();
  }
}
