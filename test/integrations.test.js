import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { GatewayApi } from '../src/http/gateway-api.js';
import { GeoClient } from '../src/geo-client.js';
import { RateLimitClient } from '../src/rate-limit-client.js';
import { RouteTable } from '../src/route-table.js';
import { Application } from '../src/application.js';
import { Config, ConfigError } from '../src/config.js';
import { routesDoc, routesEnv, silentLog, testConfig } from './helpers.js';

const listen = (/** @type {import('node:http').Server} */ s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
const origin = (/** @type {import('node:http').Server} */ s) => { const a = /** @type {import('node:net').AddressInfo} */ (s.address()); return `http://127.0.0.1:${a.port}`; };

const echo = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ headers: req.headers })); });
/** @type {{ policy: string, subject: string, cost: number, auth: string|undefined }[]} */ const checks = [];
let rlMode = 'allow';
const ratelimit = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    checks.push({ ...JSON.parse(body), auth: req.headers.authorization });
    if (rlMode === 'down') return res.writeHead(503).end('down');
    if (rlMode === 'missing') return res.writeHead(404).end('{"error":{"code":"POLICY_NOT_FOUND"}}');
    const deny = rlMode === 'deny' || rlMode === 'block';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ allowed: !deny, blocked: rlMode === 'block', limit: 100, remaining: deny ? 0 : 99, resetAt: new Date(Date.now() + 30_000).toISOString(), retryAfter: rlMode === 'block' ? null : deny ? 30 : 0 }));
  });
});
let geoHits = 0;
const geo = createServer((req, res) => {
  geoHits++;
  const ip = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
  if (ip.startsWith('10.')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'private', country: null, timezone: null }));
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'public', country: { code: 'TR' }, continent: { code: 'AS' }, timezone: 'Europe/Istanbul' }));
});

/** @type {import('fastify').FastifyInstance} */ let app;
before(async () => {
  await Promise.all([listen(echo), listen(ratelimit), listen(geo)]);
  const doc = /** @type {any} */ (routesDoc({ api: origin(echo), files: origin(echo), auth: origin(echo) }));
  doc.routes.push({ id: 'open', pathPrefix: '/open/', upstreams: [origin(echo)], policy: { name: 'api', subject: 'ip', failOpen: true }, geo: true });
  doc.routes.push({ id: 'closed', pathPrefix: '/closed/', upstreams: [origin(echo)], policy: { name: 'login', subject: 'key', cost: 2, failOpen: false } });
  const config = testConfig({ RATELIMIT_URL: origin(ratelimit), RATELIMIT_API_KEY: 'r'.repeat(40), GEO_URL: origin(geo), GEO_API_KEY: 'g'.repeat(40), GEO_CACHE_SEC: '600', METRICS_TOKEN: 'm'.repeat(40) });
  const routes = RouteTable.parse(doc, routesEnv);
  app = await new GatewayApi({ config, routes, jwt: null, logger: silentLog, policies: new RateLimitClient(/** @type {any} */ (config.ratelimit)), geo: new GeoClient(/** @type {any} */ (config.geo)) }).build();
  await app.ready();
});
after(async () => { await app.close(); echo.close(); ratelimit.close(); geo.close(); });

test('config: integrations need both variables; routes need the integration', () => {
  assert.throws(() => testConfig({ RATELIMIT_URL: 'http://x' }), (e) => e instanceof ConfigError && /set together/.test(e.message));
  assert.throws(() => testConfig({ GEO_URL: 'http://x', GEO_API_KEY: 'short' }), /at least 32/);
  const c = testConfig({ RATELIMIT_URL: 'http://rl/', RATELIMIT_API_KEY: 'r'.repeat(40) });
  assert.deepEqual(c.ratelimit, { url: 'http://rl', apiKey: 'r'.repeat(40), timeoutMs: 300 });
  assert.equal(c.geo, null);
  const doc = /** @type {any} */ (routesDoc({}));
  doc.routes.push({ id: 'p', pathPrefix: '/p/', upstreams: ['http://127.0.0.1:1'], policy: { name: 'api', failOpen: true } });
  assert.throws(() => new Application(testConfig(), RouteTable.parse(doc, routesEnv)), /need RATELIMIT_URL/);
  doc.routes.at(-1).policy = { name: 'Bad Name', failOpen: true };
  assert.throws(() => RouteTable.parse(doc, routesEnv), /policy name/);
  doc.routes.at(-1).policy = { name: 'api', subject: 'user', failOpen: true };
  assert.throws(() => RouteTable.parse(doc, routesEnv), /needs auth "user"/);
  doc.routes.at(-1).policy = { name: 'api', subject: 'ip', failOpen: 'yes' };
  assert.throws(() => RouteTable.parse(doc, routesEnv), /must be true or false/);
  doc.routes.at(-1).policy = { name: 'api', subject: 'ip' };
  assert.throws(() => RouteTable.parse(doc, routesEnv), /failOpen is required/);
});

test('policy: checks the ratelimit service per subject, sets RateLimit-* headers, answers 429 and BLOCKED', async () => {
  rlMode = 'allow'; checks.length = 0;
  let res = await app.inject({ url: '/open/x', remoteAddress: '203.0.113.7' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([checks[0].policy, checks[0].subject, checks[0].cost, checks[0].auth, res.headers['ratelimit-limit'], res.headers['ratelimit-remaining']], ['api', 'ip:203.0.113.7', 1, `Bearer ${'r'.repeat(40)}`, '100', '99']);
  assert.ok(Number(res.headers['ratelimit-reset']) <= 30);
  rlMode = 'deny';
  res = await app.inject({ url: '/open/x', remoteAddress: '203.0.113.7' });
  assert.equal(res.statusCode, 429, res.body);
  assert.deepEqual([res.statusCode, res.headers['retry-after'], JSON.parse(res.body).error.code], [429, '30', 'RATE_LIMITED']);
  rlMode = 'block';
  res = await app.inject({ url: '/open/x', remoteAddress: '203.0.113.7' });
  assert.deepEqual([res.statusCode, res.headers['retry-after'], JSON.parse(res.body).error.code], [429, undefined, 'BLOCKED']);
  rlMode = 'allow';
  res = await app.inject({ url: '/closed/x', headers: { authorization: 'Bearer client-token-1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([checks.at(-1)?.policy, checks.at(-1)?.cost, checks.at(-1)?.subject.startsWith('key:'), checks.at(-1)?.subject.includes('client-token')], ['login', 2, true, false], 'bearer tokens are hashed');
  res = await app.inject({ url: '/closed/x' });
  assert.equal(checks.at(-1)?.subject, 'ip:127.0.0.1', 'no token falls back to the IP');
});

test('policy: unavailable service fails open or closed per route; unknown policy counts as unavailable', async () => {
  rlMode = 'down';
  let res = await app.inject({ url: '/open/x' });
  assert.equal(res.statusCode, 200, 'fail open');
  res = await app.inject({ url: '/closed/x' });
  assert.deepEqual([res.statusCode, JSON.parse(res.body).error.code, res.headers['retry-after']], [503, 'RATE_LIMIT_UNAVAILABLE', '5']);
  rlMode = 'missing';
  assert.equal((await app.inject({ url: '/open/x' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/closed/x' })).statusCode, 503);
  rlMode = 'allow';
  const metrics = await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${'m'.repeat(40)}` } });
  assert.match(metrics.body, /gateway_rejected_total\{reason="policy"\} 2\n/);
  assert.match(metrics.body, /gateway_rejected_total\{reason="policy_unavailable"\} 2\n/);
  assert.match(metrics.body, /gateway_dependency_errors_total\{dependency="ratelimit"\} 4\n/);
});

test('geo: X-Geo-* headers from the geo service, cached per address, client spoofing stripped, private addresses empty', async () => {
  rlMode = 'allow'; geoHits = 0;
  let res = await app.inject({ url: '/open/x', remoteAddress: '81.5.6.7', headers: { 'x-geo-country': 'XX', 'x-geo-timezone': 'Mars/Olympus' } });
  let h = JSON.parse(res.body).headers;
  assert.deepEqual([h['x-geo-country'], h['x-geo-timezone'], h['x-geo-continent'], geoHits], ['TR', 'Europe/Istanbul', 'AS', 1]);
  res = await app.inject({ url: '/open/y', remoteAddress: '81.5.6.7' });
  assert.deepEqual([JSON.parse(res.body).headers['x-geo-country'], geoHits], ['TR', 1], 'second request served from the cache');
  res = await app.inject({ url: '/open/z', remoteAddress: '10.0.0.5' });
  h = JSON.parse(res.body).headers;
  assert.deepEqual([h['x-geo-country'], h['x-geo-timezone']], ['', '']);
  res = await app.inject({ url: '/files/x', headers: { 'x-geo-country': 'XX' } });
  assert.equal(JSON.parse(res.body).headers['x-geo-country'], undefined, 'routes without geo forward no geo headers, spoofed ones dropped');
});
