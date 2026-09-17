import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { GatewayApi } from '../src/http/gateway-api.js';
import { RouteTable } from '../src/route-table.js';
import { UpstreamPool } from '../src/upstream-pool.js';
import { capturingLog, routesDoc, routesEnv, silentLog, testConfig } from './helpers.js';

/** @param {import('node:http').Server} s */
const origin = (s) => `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (s.address()).port}`;
/** @param {import('node:http').Server} s */
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));

// ---------------------------------------------------------------- pure state machine (Stage 9)
// Fully deterministic: `now` is always caller-supplied, never `Date.now()` — no real timers, no
// real HTTP, no sleeps anywhere in this section.

test('breaker: one healthy, one open — the healthy one is always preferred, the open one is never touched', () => {
  const pool = new UpstreamPool(['http://a:1', 'http://b:1'], { connectTimeoutMs: 100, cooldownMs: 1000, breakerThreshold: 1 });
  const [a, b] = pool.upstreams;
  pool.fail(b, { now: 0 });
  assert.equal(b.state, 'open');
  for (let i = 0; i < 5; i++) assert.equal(pool.next({ now: 500 })?.origin, a.origin, 'closed upstream always wins over an open one, cooldown not elapsed or not');
  assert.equal(b.state, 'open', 'never claimed, never touched, while a healthy alternative exists');
});

test('breaker: all open, cooldown not yet elapsed — deterministic "try anyway" fallback, no deadlock, no probe claimed', () => {
  const pool = new UpstreamPool(['http://a:1', 'http://b:1'], { connectTimeoutMs: 100, cooldownMs: 1000, breakerThreshold: 1 });
  for (const u of pool.upstreams) pool.fail(u, { now: 0 });
  const picked = pool.next({ now: 500 });
  assert.ok(picked, 'a real answer, never a manufactured deadlock');
  assert.equal(picked.state, 'open', 'fallback ride-along does not claim a probe (cooldown has not elapsed for anyone)');
});

test('breaker: cooldown elapsed — claims exactly one half-open probe; a concurrent arrival never gets a second one', () => {
  const pool = new UpstreamPool(['http://a:1'], { connectTimeoutMs: 100, cooldownMs: 1000, breakerThreshold: 1 });
  const [a] = pool.upstreams;
  pool.fail(a, { now: 0 });
  assert.equal(a.state, 'open');
  /** @type {import('../src/upstream-pool.js').Transition[]} */
  const transitions = [];
  const onTransition = (/** @type {any} */ u, /** @type {any} */ t) => transitions.push(t);
  const first = pool.next({ now: 1000, onTransition });
  assert.equal(first?.origin, a.origin);
  assert.equal(a.state, 'half-open', 'the single probe was claimed');
  assert.deepEqual(transitions, [{ from: 'open', to: 'half-open' }]);
  // A second, "simultaneous" arrival (same tick, JS is single-threaded so this models concurrency
  // precisely) must NOT claim a second probe — it rides along on the same upstream (the only
  // option) without disturbing the breaker's single-probe bookkeeping.
  const second = pool.next({ now: 1000, onTransition });
  assert.equal(second?.origin, a.origin, 'still the only upstream — served anyway, per the all-down invariant');
  assert.equal(transitions.length, 1, 'no second probe/transition was claimed for the ride-along');
});

test('breaker: simultaneous half-open contenders on TWO distinct upstreams — each claims its own probe independently, never the same one twice', () => {
  const pool = new UpstreamPool(['http://a:1', 'http://b:1'], { connectTimeoutMs: 100, cooldownMs: 1000, breakerThreshold: 1 });
  const [a, b] = pool.upstreams;
  pool.fail(a, { now: 0 });
  pool.fail(b, { now: 0 });
  /** @type {import('../src/upstream-pool.js').Transition[]} */
  const transitions = [];
  const onTransition = (/** @type {any} */ u, /** @type {any} */ t) => transitions.push(t);
  const first = pool.next({ now: 1000, onTransition });
  const second = pool.next({ now: 1000, onTransition });
  assert.notEqual(first?.origin, second?.origin, 'two distinct upstreams, each gets its own probe');
  assert.equal(a.state, 'half-open');
  assert.equal(b.state, 'half-open');
  assert.equal(transitions.length, 2);
  // A third, later arrival: nothing left to claim (both already half-open) — rides along
  // deterministically on the fallback pick, claiming nothing new.
  const third = pool.next({ now: 1000, onTransition });
  assert.ok(third);
  assert.equal(transitions.length, 2, 'still exactly two probes total, ever');
});

test('breaker: probe success closes the breaker and resets the failure count; probe failure re-opens it and restarts the cooldown', () => {
  const pool = new UpstreamPool(['http://a:1'], { connectTimeoutMs: 100, cooldownMs: 1000, breakerThreshold: 1 });
  const [a] = pool.upstreams;
  pool.fail(a, { now: 0 });
  const probe = pool.next({ now: 1000 });
  assert.equal(probe?.state, 'half-open');
  pool.succeed(a);
  assert.deepEqual([a.state, a.failures], ['closed', 0]);

  pool.fail(a, { now: 2000 }); // closed → open again (threshold 1)
  assert.equal(a.state, 'open');
  const probe2 = pool.next({ now: 3000 });
  assert.equal(probe2?.state, 'half-open');
  pool.fail(a, { now: 3000 }); // probe itself fails
  assert.equal(a.state, 'open', 'probe failure re-opens, never stays half-open');
  assert.equal(pool.next({ now: 3500 }), a, 'still down: the cooldown genuinely restarted');
  assert.equal(a.state, 'open');
  assert.equal(pool.next({ now: 4000 })?.state, 'half-open', 'eligible again only after the NEW cooldown (from 3000) elapses');
});

test('breaker: threshold > 1 tolerates that many consecutive failures before opening', () => {
  const pool = new UpstreamPool(['http://a:1'], { connectTimeoutMs: 100, cooldownMs: 1000, breakerThreshold: 3 });
  const [a] = pool.upstreams;
  pool.fail(a, { now: 0 });
  assert.equal(a.state, 'closed');
  pool.fail(a, { now: 0 });
  assert.equal(a.state, 'closed');
  pool.fail(a, { now: 0 });
  assert.equal(a.state, 'open', 'opens on the 3rd consecutive failure');
  pool.destroy();
});

// ---------------------------------------------------------------- failure classification (real HTTP)

const ok200 = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('ok'); });
const err500 = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(500).end('server error'); });
const err400 = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(400).end('bad request'); });

before(() => Promise.all([listen(ok200), listen(err500), listen(err400)]));
after(() => { for (const s of [ok200, err500, err400]) s.close(); });

/** @param {Record<string,string>} origins @param {Record<string,string>} [envOverrides] */
async function buildApi(origins, envOverrides = {}) {
  const doc = {
    routes: [
      { id: 'oks', pathPrefix: '/oks/', upstreams: [origins.ok] },
      { id: 'errs', pathPrefix: '/errs/', upstreams: [origins.err500] },
      { id: 'bads', pathPrefix: '/bads/', upstreams: [origins.err400] },
    ],
  };
  const routes = RouteTable.parse(doc, {});
  const config = testConfig({ METRICS_TOKEN: 'm'.repeat(40), ...envOverrides });
  const api = new GatewayApi({ config, routes, jwt: null, logger: silentLog });
  const app = await api.build();
  await app.ready();
  return { api, app };
}

test('failure classification: upstream 5xx opens the breaker (threshold 1); a client 4xx never does, no matter how many', async () => {
  const { api, app } = await buildApi({ ok: origin(ok200), err500: origin(err500), err400: origin(err400) }, { UPSTREAM_BREAKER_THRESHOLD: '1' });
  try {
    let res = await app.inject({ url: '/errs/x' });
    assert.equal(res.statusCode, 500);
    assert.equal(/** @type {UpstreamPool} */ (api.pools.get('errs')).upstreams[0].state, 'open', '5xx counted as a breaker failure');

    for (let i = 0; i < 5; i++) {
      res = await app.inject({ url: '/bads/x' });
      assert.equal(res.statusCode, 400);
    }
    const bads = /** @type {UpstreamPool} */ (api.pools.get('bads')).upstreams[0];
    assert.deepEqual([bads.state, bads.failures], ['closed', 0], 'a client 4xx is never held against the upstream');
  } finally { await app.close(); api.destroy(); }
});

test('failure classification: connect failure and timeout both open the breaker', async () => {
  const doc = {
    routes: [
      { id: 'dead', pathPrefix: '/dead/', upstreams: ['http://127.0.0.1:1'] },
      { id: 'slow', pathPrefix: '/slow/', upstreams: [origin(ok200)], timeoutMs: 100 },
    ],
  };
  const slowSite = createServer((_req, res) => setTimeout(() => res.writeHead(200).end('late'), 500));
  await listen(slowSite);
  doc.routes[1].upstreams = [origin(slowSite)];
  const routes = RouteTable.parse(doc, {});
  const api = new GatewayApi({ config: testConfig({ UPSTREAM_BREAKER_THRESHOLD: '1' }), routes, jwt: null, logger: silentLog });
  const app = await api.build();
  await app.ready();
  try {
    let res = await app.inject({ url: '/dead/x' });
    assert.equal(res.statusCode, 502);
    assert.equal(/** @type {UpstreamPool} */ (api.pools.get('dead')).upstreams[0].state, 'open', 'connect failure opens the breaker');
    res = await app.inject({ url: '/slow/x' });
    assert.equal(res.statusCode, 504);
    assert.equal(/** @type {UpstreamPool} */ (api.pools.get('slow')).upstreams[0].state, 'open', 'timeout opens the breaker');
  } finally { await app.close(); api.destroy(); slowSite.close(); }
});

// ---------------------------------------------------------------- telemetry (Stage 9)

test('telemetry: access log carries upstreamMs; /metrics exposes upstream latency histogram, breaker state and transitions, bounded by route+upstream only', async () => {
  const { log, calls } = capturingLog();
  const doc = {
    routes: [
      { id: 'oks', pathPrefix: '/oks/', upstreams: [origin(ok200)] },
      { id: 'errs', pathPrefix: '/errs/', upstreams: [origin(err500)] },
    ],
  };
  const routes = RouteTable.parse(doc, {});
  const config = testConfig({ METRICS_TOKEN: 'm'.repeat(40), UPSTREAM_BREAKER_THRESHOLD: '1' });
  const api = new GatewayApi({ config, routes, jwt: null, logger: log });
  const app = await api.build();
  await app.ready();
  try {
    await app.inject({ url: '/oks/x' });
    await app.inject({ url: '/errs/x' });
    const access = calls.filter((c) => c.args[1] === 'access');
    assert.equal(access.length, 2);
    for (const a of access) assert.equal(typeof /** @type {any} */ (a.args[0]).upstreamMs, 'number', 'every proxied request logs upstreamMs');
    const transition = calls.find((c) => c.args[1] === 'breaker transition');
    assert.ok(transition, 'a structured, one-off log line on the transition — not per request');
    assert.deepEqual(/** @type {any} */ (transition?.args[0]), { route: 'errs', upstream: origin(err500), from: 'closed', to: 'open' });

    const m = await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${'m'.repeat(40)}` } });
    assert.match(m.body, /gateway_upstream_latency_ms_bucket\{route="oks",le="\+Inf"\} 1/);
    assert.match(m.body, new RegExp(`gateway_upstream_breaker_state\\{route="errs",upstream="${origin(err500).replace(/[.:]/g, '\\$&')}"\\} 2`));
    assert.match(m.body, new RegExp(`gateway_upstream_breaker_state\\{route="oks",upstream="${origin(ok200).replace(/[.:]/g, '\\$&')}"\\} 0`), 'closed=0, never-failed upstream still reported');
    assert.match(m.body, /gateway_breaker_transitions_total\{route="errs".*from="closed",to="open"\} 1/);
    // Cardinality guard: the latency histogram is per ROUTE only — never per raw request URL, IP,
    // user id or request id, and never per upstream instance either (that's the breaker gauges'
    // job, which is itself bounded by the small, static, config-defined set of routes/upstreams).
    assert.doesNotMatch(m.body, /gateway_upstream_latency_ms[^\n]*upstream=/, 'latency histogram must not be labeled by upstream');
  } finally { await app.close(); api.destroy(); }
});

// ---------------------------------------------------------------- startup warning (Stage 9, item 3)

test('startup warning: a public route rate-limited by IP with failOpen:true logs a structured, actionable warning — never a startup failure', async () => {
  const { log, calls } = capturingLog();
  const doc = /** @type {any} */ (routesDoc({}));
  doc.routes.push({ id: 'public-ip-open', pathPrefix: '/pub/', upstreams: ['http://127.0.0.1:1'], policy: { name: 'api', subject: 'ip', failOpen: true } });
  const routes = RouteTable.parse(doc, routesEnv);
  const config = testConfig({ RATELIMIT_URL: 'http://127.0.0.1:1', RATELIMIT_API_KEY: 'r'.repeat(40) });
  const api = new GatewayApi({ config, routes, jwt: null, logger: log });
  const app = await api.build();
  await app.ready();
  try {
    const warning = calls.find((c) => c.level === 'warn' && /** @type {any} */ (c.args[0])?.route === 'public-ip-open');
    assert.ok(warning, 'warns at startup');
    assert.deepEqual(warning?.args[0], { route: 'public-ip-open', subject: 'ip', failOpen: true, dependency: 'ratelimit' });
    assert.doesNotMatch(JSON.stringify(warning?.args[0]), /r{40}|RATELIMIT_API_KEY/, 'never logs the secret');
  } finally { await app.close(); api.destroy(); }
});

test('startup warning: does not fire for a user-authenticated route, a non-ip subject, or failOpen:false', async () => {
  const { log, calls } = capturingLog();
  const doc = /** @type {any} */ (routesDoc({}));
  doc.routes.push({ id: 'user-route', pathPrefix: '/u/', upstreams: ['http://127.0.0.1:1'], auth: 'user', policy: { name: 'api', subject: 'user', failOpen: true } });
  doc.routes.push({ id: 'key-route', pathPrefix: '/k/', upstreams: ['http://127.0.0.1:1'], policy: { name: 'api', subject: 'key', failOpen: true } });
  doc.routes.push({ id: 'closed-route', pathPrefix: '/c/', upstreams: ['http://127.0.0.1:1'], policy: { name: 'api', subject: 'ip', failOpen: false } });
  const routes = RouteTable.parse(doc, routesEnv);
  const config = testConfig({ RATELIMIT_URL: 'http://127.0.0.1:1', RATELIMIT_API_KEY: 'r'.repeat(40) });
  const api = new GatewayApi({ config, routes, jwt: null, logger: log });
  const app = await api.build();
  await app.ready();
  try {
    assert.equal(calls.some((c) => c.level === 'warn'), false, 'none of these combinations warrant the warning');
  } finally { await app.close(); api.destroy(); }
});
