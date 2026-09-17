/** In-process counters and latency histograms per route, exported in Prometheus text format. */
export class Metrics {
  static BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

  constructor() {
    /** @type {Map<string, { requests: Map<string, number>, latency: number[], latencySum: number, latencyCount: number, bytesIn: number, bytesOut: number, upstreamErrors: number, upstreamLatency: number[], upstreamLatencySum: number, upstreamLatencyCount: number }>} */
    this.routes = new Map();
    this.gateway = { rateLimited: 0, unauthorized: 0, noRoute: 0, policyDenied: 0, policyUnavailable: 0 };
    this.dependencies = { ratelimit: 0, geo: 0 };
    // Stage 9: transitions are a true counter (cumulative, event-driven — incremented once per
    // actual breaker state change, never reset by a reload). Current state/failure count are NOT
    // shadowed here — `render()` reads those live off the caller's current pools, so they're never
    // stale and never need reconciling after a routes reload swaps in fresh pool objects.
    /** @type {Map<string, number>} */
    this.breakerTransitions = new Map();
  }

  /** @param {string} routeId */
  #route(routeId) {
    let r = this.routes.get(routeId);
    if (!r) {
      r = { requests: new Map(), latency: new Array(Metrics.BUCKETS_MS.length + 1).fill(0), latencySum: 0, latencyCount: 0, bytesIn: 0, bytesOut: 0, upstreamErrors: 0, upstreamLatency: new Array(Metrics.BUCKETS_MS.length + 1).fill(0), upstreamLatencySum: 0, upstreamLatencyCount: 0 };
      this.routes.set(routeId, r);
    }
    return r;
  }

  /**
   * @param {string} routeId
   * @param {number} upstreamMs
   */
  observeUpstreamLatency(routeId, upstreamMs) {
    const r = this.#route(routeId);
    let i = Metrics.BUCKETS_MS.findIndex((b) => upstreamMs <= b);
    if (i === -1) i = Metrics.BUCKETS_MS.length;
    for (; i < r.upstreamLatency.length; i++) r.upstreamLatency[i] += 1;
    r.upstreamLatencySum += upstreamMs;
    r.upstreamLatencyCount += 1;
  }

  /**
   * Bounded cardinality: `route`+`upstream` are both config-defined and finite (the set of routes
   * and their upstream origins from routes.json), never a value that varies per request — the same
   * reasoning that keeps `route` alone bounded for the other per-route metrics above.
   * @param {string} routeId
   * @param {string} origin
   * @param {string} from
   * @param {string} to
   */
  breakerTransition(routeId, origin, from, to) {
    const key = `${routeId}\0${origin}\0${from}\0${to}`;
    this.breakerTransitions.set(key, (this.breakerTransitions.get(key) ?? 0) + 1);
  }

  /**
   * @param {string} routeId
   * @param {number} status
   * @param {number} durationMs
   * @param {{ bytesIn?: number, bytesOut?: number }} [io]
   */
  observe(routeId, status, durationMs, { bytesIn = 0, bytesOut = 0 } = {}) {
    const r = this.#route(routeId);
    const cls = `${Math.floor(status / 100)}xx`;
    r.requests.set(cls, (r.requests.get(cls) ?? 0) + 1);
    let i = Metrics.BUCKETS_MS.findIndex((b) => durationMs <= b);
    if (i === -1) i = Metrics.BUCKETS_MS.length;
    for (; i < r.latency.length; i++) r.latency[i] += 1;
    r.latencySum += durationMs;
    r.latencyCount += 1;
    r.bytesIn += bytesIn;
    r.bytesOut += bytesOut;
  }

  /** @param {string} routeId */
  upstreamError(routeId) {
    this.#route(routeId).upstreamErrors += 1;
  }

  /**
   * @param {Map<string, import('./upstream-pool.js').UpstreamPool>} [pools]  Stage 9: read live,
   *   straight off the caller's CURRENT pools — never shadowed internally, so a routes reload that
   *   swaps in fresh pool objects is reflected immediately with nothing to reconcile.
   * @returns {string}
   */
  render(pools = new Map()) {
    const out = [
      '# HELP gateway_requests_total Requests by route and status class.', '# TYPE gateway_requests_total counter',
    ];
    for (const [id, r] of this.routes) for (const [cls, n] of r.requests) out.push(`gateway_requests_total{route="${id}",status="${cls}"} ${n}`);
    out.push('# HELP gateway_request_duration_ms Request duration including upstream time.', '# TYPE gateway_request_duration_ms histogram');
    for (const [id, r] of this.routes) {
      Metrics.BUCKETS_MS.forEach((b, i) => out.push(`gateway_request_duration_ms_bucket{route="${id}",le="${b}"} ${r.latency[i]}`));
      out.push(`gateway_request_duration_ms_bucket{route="${id}",le="+Inf"} ${r.latency[Metrics.BUCKETS_MS.length]}`);
      out.push(`gateway_request_duration_ms_sum{route="${id}"} ${r.latencySum}`);
      out.push(`gateway_request_duration_ms_count{route="${id}"} ${r.latencyCount}`);
    }
    out.push('# HELP gateway_upstream_latency_ms Time spent talking to the upstream (connect through last response byte), per route — never per raw request URL/user/IP/upstream instance.', '# TYPE gateway_upstream_latency_ms histogram');
    for (const [id, r] of this.routes) {
      Metrics.BUCKETS_MS.forEach((b, i) => out.push(`gateway_upstream_latency_ms_bucket{route="${id}",le="${b}"} ${r.upstreamLatency[i]}`));
      out.push(`gateway_upstream_latency_ms_bucket{route="${id}",le="+Inf"} ${r.upstreamLatency[Metrics.BUCKETS_MS.length]}`);
      out.push(`gateway_upstream_latency_ms_sum{route="${id}"} ${r.upstreamLatencySum}`);
      out.push(`gateway_upstream_latency_ms_count{route="${id}"} ${r.upstreamLatencyCount}`);
    }
    out.push('# HELP gateway_upstream_breaker_state Circuit breaker state: 0=closed, 1=half-open, 2=open.', '# TYPE gateway_upstream_breaker_state gauge');
    const STATE_CODE = { closed: 0, 'half-open': 1, open: 2 };
    for (const [routeId, pool] of pools) for (const u of pool.upstreams) out.push(`gateway_upstream_breaker_state{route="${routeId}",upstream="${u.origin}"} ${STATE_CODE[u.state]}`);
    out.push('# HELP gateway_upstream_breaker_failures Consecutive failures counted toward the breaker opening (closed state only).', '# TYPE gateway_upstream_breaker_failures gauge');
    for (const [routeId, pool] of pools) for (const u of pool.upstreams) out.push(`gateway_upstream_breaker_failures{route="${routeId}",upstream="${u.origin}"} ${u.failures}`);
    out.push('# HELP gateway_breaker_transitions_total Circuit breaker state transitions.', '# TYPE gateway_breaker_transitions_total counter');
    for (const [key, n] of this.breakerTransitions) {
      const [routeId, origin, from, to] = key.split('\0');
      out.push(`gateway_breaker_transitions_total{route="${routeId}",upstream="${origin}",from="${from}",to="${to}"} ${n}`);
    }
    out.push('# HELP gateway_bytes_total Body bytes by direction.', '# TYPE gateway_bytes_total counter');
    for (const [id, r] of this.routes) out.push(`gateway_bytes_total{route="${id}",direction="in"} ${r.bytesIn}`, `gateway_bytes_total{route="${id}",direction="out"} ${r.bytesOut}`);
    out.push('# HELP gateway_upstream_errors_total Failed upstream attempts.', '# TYPE gateway_upstream_errors_total counter');
    for (const [id, r] of this.routes) out.push(`gateway_upstream_errors_total{route="${id}"} ${r.upstreamErrors}`);
    out.push(
      '# HELP gateway_rejected_total Requests rejected by the gateway itself.', '# TYPE gateway_rejected_total counter',
      `gateway_rejected_total{reason="rate_limited"} ${this.gateway.rateLimited}`,
      `gateway_rejected_total{reason="unauthorized"} ${this.gateway.unauthorized}`,
      `gateway_rejected_total{reason="no_route"} ${this.gateway.noRoute}`,
      `gateway_rejected_total{reason="policy"} ${this.gateway.policyDenied}`,
      `gateway_rejected_total{reason="policy_unavailable"} ${this.gateway.policyUnavailable}`,
      '# HELP gateway_dependency_errors_total Failed calls to the ratelimit and geo services (fail-open requests included).', '# TYPE gateway_dependency_errors_total counter',
      `gateway_dependency_errors_total{dependency="ratelimit"} ${this.dependencies.ratelimit}`,
      `gateway_dependency_errors_total{dependency="geo"} ${this.dependencies.geo}`,
      '# HELP gateway_process_uptime_seconds Process uptime.', '# TYPE gateway_process_uptime_seconds gauge',
      `gateway_process_uptime_seconds ${process.uptime().toFixed(0)}`,
      '',
    );
    return out.join('\n');
  }
}
