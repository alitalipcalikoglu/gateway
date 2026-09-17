import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { GatewayApi } from '../src/http/gateway-api.js';
import { RouteTable } from '../src/route-table.js';
import { routesDoc, routesEnv, silentLog, testConfig } from './helpers.js';

/** @param {import('node:http').Server} s */
const origin = (s) => `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (s.address()).port}`;
/** @param {import('node:http').Server} s */
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));

// Reports the headers it received, nothing else.
const echo = createServer((req, res) => {
  if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok');
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ headers: req.headers }));
});

const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const HEX32 = /^[0-9a-f]{32}$/;

/** @param {boolean} trustProxy */
async function buildApp(trustProxy) {
  const doc = routesDoc({ api: origin(echo), files: origin(echo), auth: origin(echo) });
  const routes = RouteTable.parse(doc, routesEnv);
  const config = testConfig({ TRUST_PROXY: String(trustProxy) });
  const api = new GatewayApi({ config, routes, jwt: null, logger: silentLog });
  const app = await api.build();
  await app.ready();
  return { app, api };
}

/** @type {Awaited<ReturnType<typeof buildApp>>} */ let untrusted;
/** @type {Awaited<ReturnType<typeof buildApp>>} */ let trusted;

before(async () => {
  await listen(echo);
  untrusted = await buildApp(false);
  trusted = await buildApp(true);
});
after(async () => {
  await untrusted.app.close(); untrusted.api.destroy();
  await trusted.app.close(); trusted.api.destroy();
  echo.close();
});

test('TRUST_PROXY=false (default): an inbound X-Request-Id and traceparent from the client are discarded', async () => {
  const res = await untrusted.app.inject({ url: '/files/x', headers: { 'x-request-id': 'client-supplied-id', traceparent: VALID_TRACEPARENT } });
  assert.equal(res.statusCode, 200, res.body);
  const upstream = res.json().headers;
  assert.notEqual(upstream['x-request-id'], 'client-supplied-id', 'the client cannot set the request id the gateway logs and forwards');
  assert.notEqual(upstream.traceparent.split('-')[1], TRACE_ID, 'the client cannot splice itself into an arbitrary trace');
  assert.match(upstream.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, 'a fresh, well-formed traceparent is generated instead');
  // The gateway is internally consistent: what it logs/echoes to the client is what it sent upstream.
  assert.equal(res.headers['x-request-id'], upstream['x-request-id']);
  assert.equal(res.headers.traceparent, upstream.traceparent);
});

test('TRUST_PROXY=true: a well-formed inbound X-Request-Id and traceparent are honoured', async () => {
  const res = await trusted.app.inject({ url: '/files/x', headers: { 'x-request-id': 'edge-proxy-req-42', traceparent: VALID_TRACEPARENT } });
  assert.equal(res.statusCode, 200, res.body);
  const upstream = res.json().headers;
  assert.equal(upstream['x-request-id'], 'edge-proxy-req-42', 'trusted request id is forwarded unchanged');
  assert.equal(res.headers['x-request-id'], 'edge-proxy-req-42', 'and echoed back to the caller');
  const [, traceId, spanId] = upstream.traceparent.split('-');
  assert.equal(traceId, TRACE_ID, 'the trusted trace is continued: same trace-id all the way to the upstream');
  assert.notEqual(spanId, '00f067aa0ba902b7', 'but the gateway mints its own span id for its own hop, never reusing the caller’s');
  assert.equal(res.headers.traceparent, upstream.traceparent, 'gateway and upstream agree on the trace it propagated');
});

test('TRUST_PROXY=true: a malformed or injected X-Request-Id is still rejected, not blindly trusted', async () => {
  for (const bad of ['', 'has a space', 'line\ninjection', 'a'.repeat(500)]) {
    const res = await trusted.app.inject({ url: '/files/x', headers: { 'x-request-id': bad } });
    assert.equal(res.statusCode, 200, res.body);
    const got = res.json().headers['x-request-id'];
    assert.notEqual(got, bad, `rejected: ${JSON.stringify(bad)}`);
    assert.match(String(got), /^[\x21-\x7e]{1,128}$/, 'a syntactically safe id is generated instead');
  }
});

test('TRUST_PROXY=true: a malformed or reserved traceparent falls back to a fresh trace, not a crash', async () => {
  for (const bad of ['not-a-traceparent', '00-00000000000000000000000000000000-00f067aa0ba902b7-01', '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01']) {
    const res = await trusted.app.inject({ url: '/files/x', headers: { traceparent: bad } });
    assert.equal(res.statusCode, 200, res.body);
    const upstream = res.json().headers.traceparent;
    assert.match(upstream, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, `well-formed fallback for input ${JSON.stringify(bad)}`);
  }
});

test('both trust settings still work end to end: request completes, upstream sees the route it should', async () => {
  for (const { app } of [untrusted, trusted]) {
    const res = await app.inject({ url: '/files/y' });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().headers['x-request-id']);
    assert.match(res.json().headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  }
});
