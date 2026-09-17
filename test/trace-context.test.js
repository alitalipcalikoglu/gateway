import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TraceContext } from '../src/trace-context.js';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

test('TraceContext.parse: accepts a well-formed header, rejects everything else', () => {
  const good = TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.deepEqual([good?.traceId, good?.spanId, good?.flags], ['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', '01']);
  assert.equal(TraceContext.parse(undefined), null);
  assert.equal(TraceContext.parse(''), null);
  assert.equal(TraceContext.parse('not-a-traceparent'), null, 'wrong shape');
  assert.equal(TraceContext.parse('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null, 'unsupported version');
  assert.equal(TraceContext.parse('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01'), null, 'upper-case hex rejected, matching the spec’s lower-case-only header');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01'), null, 'trace-id one char short');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra'), null, 'trailing junk');
  assert.equal(TraceContext.parse('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null, 'reserved all-zero trace-id');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'), null, 'reserved all-zero parent-id');
  assert.notEqual(TraceContext.parse('  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  '), null, 'surrounding whitespace is trimmed before matching');
});

test('TraceContext.forRequest: honours a valid header only when trusted; always mints a fresh span id', () => {
  const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const trusted = TraceContext.forRequest(inbound, true);
  assert.equal(trusted.traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'trace-id continues the caller’s trace');
  assert.notEqual(trusted.spanId, '00f067aa0ba902b7', 'a new span id is minted for this hop, never the caller’s');
  assert.match(trusted.spanId, HEX16);

  const untrusted = TraceContext.forRequest(inbound, false);
  assert.notEqual(untrusted.traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'an untrusted caller cannot inject a trace-id');
  assert.match(untrusted.traceId, HEX32);

  const noHeader = TraceContext.forRequest(undefined, true);
  assert.match(noHeader.traceId, HEX32);
  assert.match(noHeader.spanId, HEX16);
  assert.equal(noHeader.flags, '01');

  const malformedWhileTrusted = TraceContext.forRequest('garbage', true);
  assert.match(malformedWhileTrusted.traceId, HEX32);

  // Two independent calls never collide.
  const a = TraceContext.forRequest(undefined, false);
  const b = TraceContext.forRequest(undefined, false);
  assert.notEqual(a.traceId, b.traceId);
  assert.notEqual(a.spanId, b.spanId);
});

test('TraceContext#toString formats as version-traceId-spanId-flags', () => {
  const t = new TraceContext('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', '01');
  assert.equal(t.toString(), '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.equal(new TraceContext('a'.repeat(32), 'b'.repeat(16)).toString(), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, 'flags default to 01 (sampled)');
});
