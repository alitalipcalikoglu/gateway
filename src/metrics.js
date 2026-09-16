/** In-process counters and latency histograms per route, exported in Prometheus text format. */
export class Metrics {
  static BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

  constructor() {
    /** @type {Map<string, { requests: Map<string, number>, latency: number[], latencySum: number, latencyCount: number, bytesIn: number, bytesOut: number, upstreamErrors: number }>} */
    this.routes = new Map();
    this.gateway = { rateLimited: 0, unauthorized: 0, noRoute: 0 };
  }

  /** @param {string} routeId */
  #route(routeId) {
    let r = this.routes.get(routeId);
    if (!r) {
      r = { requests: new Map(), latency: new Array(Metrics.BUCKETS_MS.length + 1).fill(0), latencySum: 0, latencyCount: 0, bytesIn: 0, bytesOut: 0, upstreamErrors: 0 };
      this.routes.set(routeId, r);
    }
    return r;
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

  /** @returns {string} */
  render() {
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
    out.push('# HELP gateway_bytes_total Body bytes by direction.', '# TYPE gateway_bytes_total counter');
    for (const [id, r] of this.routes) out.push(`gateway_bytes_total{route="${id}",direction="in"} ${r.bytesIn}`, `gateway_bytes_total{route="${id}",direction="out"} ${r.bytesOut}`);
    out.push('# HELP gateway_upstream_errors_total Failed upstream attempts.', '# TYPE gateway_upstream_errors_total counter');
    for (const [id, r] of this.routes) out.push(`gateway_upstream_errors_total{route="${id}"} ${r.upstreamErrors}`);
    out.push(
      '# HELP gateway_rejected_total Requests rejected by the gateway itself.', '# TYPE gateway_rejected_total counter',
      `gateway_rejected_total{reason="rate_limited"} ${this.gateway.rateLimited}`,
      `gateway_rejected_total{reason="unauthorized"} ${this.gateway.unauthorized}`,
      `gateway_rejected_total{reason="no_route"} ${this.gateway.noRoute}`,
      '# HELP gateway_process_uptime_seconds Process uptime.', '# TYPE gateway_process_uptime_seconds gauge',
      `gateway_process_uptime_seconds ${process.uptime().toFixed(0)}`,
      '',
    );
    return out.join('\n');
  }
}
