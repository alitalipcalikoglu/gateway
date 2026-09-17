import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context (`traceparent` header, https://www.w3.org/TR/trace-context/): the minimum
 * this gateway needs to correlate one client request across every service it touches, without
 * pulling in a tracing SDK. A trust boundary applies: an inbound header is honoured only when the
 * gateway is told it sits behind something that sets it faithfully (`TRUST_PROXY=true`); anyone
 * else's header is discarded and a fresh trace is started, exactly like inbound `X-Request-Id`.
 */
export class TraceContext {
  static VERSION = '00';
  /** version-traceId-parentId-flags, each field fixed-width lower-case hex per the spec. */
  static HEADER_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

  /**
   * @param {string} traceId 32 hex chars, identifies the whole request across every hop.
   * @param {string} spanId  16 hex chars, identifies this hop.
   * @param {string} [flags] 2 hex chars; `01` = sampled.
   */
  constructor(traceId, spanId, flags = '01') {
    this.traceId = traceId;
    this.spanId = spanId;
    this.flags = flags;
  }

  /**
   * The context for one incoming request: continues the caller's trace when `trusted` and the
   * header is a well-formed `traceparent`, otherwise starts a new one. Either way a fresh span id
   * is minted for this hop — an inbound span id belongs to the caller, never to this hop.
   * @param {string|undefined} header
   * @param {boolean} trusted
   */
  static forRequest(header, trusted) {
    const parsed = trusted ? TraceContext.parse(header) : null;
    return new TraceContext(parsed?.traceId ?? randomBytes(16).toString('hex'), randomBytes(8).toString('hex'), parsed?.flags ?? '01');
  }

  /**
   * @param {string|undefined} header
   * @returns {TraceContext|null} `null` for a missing or malformed header, or one using the
   *   reserved all-zero trace-id/parent-id the spec says must be treated as absent.
   */
  static parse(header) {
    if (!header) return null;
    const m = TraceContext.HEADER_PATTERN.exec(header.trim());
    if (!m) return null;
    const [, traceId, spanId, flags] = m;
    if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
    return new TraceContext(traceId, spanId, flags);
  }

  toString() {
    return `${TraceContext.VERSION}-${this.traceId}-${this.spanId}-${this.flags}`;
  }
}
