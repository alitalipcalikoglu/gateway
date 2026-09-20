import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { exportJWK, importPKCS8, SignJWT } from 'jose';
import { GatewayApi } from '../src/http/gateway-api.js';
import { JwtVerifier } from '../src/jwt-verifier.js';
import { RouteTable } from '../src/route-table.js';
import { routesDoc, routesEnv, SECRET, silentLog, testConfig } from './helpers.js';

/** @param {import('node:http').Server} s */
const origin = (s) => `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (s.address()).port}`;
/** @param {import('node:http').Server} s */
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));

// Echo upstream: reports what it received.
const echo = createServer((req, res) => {
  const chunks = /** @type {Buffer[]} */ ([]);
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const p = (req.url ?? '').split('?')[0];
    if (p.endsWith('/health')) return res.writeHead(200).end('ok');
    if (p.endsWith('/slow')) return setTimeout(() => res.writeHead(200).end('late'), 1500);
    if (p.endsWith('/big')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '200000' }); return res.end(Buffer.alloc(200000, 7)); }
    if (p.endsWith('/nocontent')) return res.writeHead(204).end();
    if (p.endsWith('/hop')) return res.writeHead(200, { connection: 'close', 'transfer-encoding': 'chunked', server: 'secret-server/9', 'x-powered-by': 'php', 'x-keep': 'yes' }).end('h');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
});
// Flaky upstream: counts hits, refuses nothing but we close it to simulate an outage.
let flakyHits = 0;
const flaky = createServer((req, res) => { flakyHits += 1; res.writeHead(200).end('flaky'); });
// JWKS server.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pkcs8 = /** @type {string} */ (privateKey.export({ type: 'pkcs8', format: 'pem' }));
const jwks = createServer(async (_req, res) => {
  const jwk = publicKey.export({ format: 'jwk' });
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] }));
});

/** @param {Record<string, unknown>} [claims] @param {{ issuer?: string, expiresIn?: string }} [o] */
async function token(claims = {}, { issuer = 'https://auth.test.local', expiresIn = '5m' } = {}) {
  const key = await importPKCS8(pkcs8, 'ES256');
  return new SignJWT({ sid: 's1', email: 'u@test.local', email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(issuer).setAudience('shop').setSubject('u1').setIssuedAt().setExpirationTime(expiresIn).sign(key);
}

/** @type {import('fastify').FastifyInstance} */
let app;
/** @type {GatewayApi} */
let api;

before(async () => {
  await Promise.all([listen(echo), listen(flaky), listen(jwks)]);
  const doc = /** @type {any} */ (routesDoc({ api: origin(echo), files: origin(echo), auth: origin(echo) }));
  doc.jwt.jwksUrl = `${origin(jwks)}/.well-known/jwks.json`;
  doc.routes.push({ id: 'flaky', pathPrefix: '/flaky/', upstreams: ['http://127.0.0.1:1', origin(flaky)] });
  doc.routes.push({ id: 'slow', pathPrefix: '/slow/', stripPrefix: '/slow', upstreams: [origin(echo)], timeoutMs: 300 });
  doc.routes.push({ id: 'dead', pathPrefix: '/dead/', upstreams: ['http://127.0.0.1:1'] });
  const routes = RouteTable.parse(doc, routesEnv);
  const config = testConfig({ METRICS_TOKEN: 'm'.repeat(40), RATE_LIMIT_MAX: '1000', BODY_LIMIT: '10000' });
  api = new GatewayApi({ config, routes, jwt: new JwtVerifier(/** @type {any} */ (routes.jwt)), logger: silentLog });
  app = await api.build();
  await app.ready();
});
after(async () => {
  await app.close();
  api.destroy();
  for (const s of [echo, flaky, jwks]) s.close();
});

test('canonical OpenAPI document is public, reserved and served byte-for-byte', async () => {
  const spec = await app.inject({ url: '/openapi.yaml' });
  assert.equal(spec.statusCode, 200);
  assert.equal(spec.body, readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  assert.match(String(spec.headers['content-type']), /^text\/yaml/);
  assert.equal(GatewayApi.RESERVED.has('/openapi.yaml'), true);
});

test('routes by prefix and host, rewrites the path, forwards standard headers, hides internals', async () => {
  let res = await app.inject({ url: '/api/auth/login?x=1', method: 'POST', payload: { email: 'a@b.co' }, headers: { 'content-type': 'application/json', 'x-client-ip': '1.1.1.1', 'x-user-id': 'spoof', 'x-forwarded-for': '9.9.9.9', connection: 'keep-alive, x-secret', 'x-secret': 'drop' } });
  assert.equal(res.statusCode, 200, res.body);
  const seen = res.json();
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/login?x=1', 'stripPrefix applied, query kept');
  assert.equal(seen.body, '{"email":"a@b.co"}');
  assert.equal(seen.headers.authorization, `Bearer ${routesEnv.AUTH_API_KEY}`, 'service key injected');
  assert.equal(seen.headers['x-client-ip'], '127.0.0.1', 'client cannot spoof X-Client-IP');
  assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(seen.headers['x-user-id'], undefined, 'client X-User-* stripped');
  assert.equal(seen.headers['x-secret'], undefined, 'Connection-listed header stripped');
  assert.ok(seen.headers['x-request-id']);
  assert.match(seen.headers.via, /1\.1 atc-gateway/);
  assert.match(String(seen.headers.host), /^127\.0\.0\.1:\d+$/, 'Host rewritten to upstream');
  assert.equal(res.headers['x-request-id'], seen.headers['x-request-id']);
  assert.equal(res.headers.server, 'atc-gateway');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  res = await app.inject({ url: '/files/abc/original' });
  assert.equal(res.json().url, '/files/abc/original', 'no strip');
  assert.equal((await app.inject({ url: '/files/abc', method: 'DELETE' })).statusCode, 405);
  assert.equal((await app.inject({ url: '/nowhere' })).statusCode, 404);
  res = await app.inject({ url: '/anything', headers: { host: 'shop.test.local' } });
  assert.equal(res.json().url, '/anything', 'host-bound catch-all');
  assert.equal((await app.inject({ url: '/api/media/x', method: 'PUT', payload: 'x' })).statusCode, 401, 'user auth required');
});

test('relays status, bodies and headers faithfully; strips hop-by-hop and server headers', async () => {
  let res = await app.inject({ url: '/files/big' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.length, 200000);
  assert.equal(res.headers['content-length'], '200000');
  res = await app.inject({ url: '/files/nocontent' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  res = await app.inject({ url: '/files/hop' });
  assert.equal(res.body, 'h');
  assert.equal(res.headers['x-keep'], 'yes');
  assert.equal(res.headers.server, 'atc-gateway');
  assert.equal(res.headers['x-powered-by'], undefined);
  assert.match(String(res.headers.via), /atc-gateway/);
  res = await app.inject({ url: '/files/big', method: 'HEAD' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.length, 0);
});

test('user auth: valid JWT becomes X-User-* headers and the service key; bad tokens are 401', async () => {
  const good = await token();
  let res = await app.inject({ url: '/api/media/files', headers: { authorization: `Bearer ${good}` } });
  assert.equal(res.statusCode, 200, res.body);
  const seen = res.json();
  assert.equal(seen.url, '/files');
  assert.equal(seen.headers.authorization, `Bearer ${SECRET}`, 'user token replaced by service key');
  assert.equal(seen.headers['x-user-id'], 'u1');
  assert.equal(seen.headers['x-user-session'], 's1');
  assert.equal(seen.headers['x-user-email'], 'u@test.local');
  assert.equal(seen.headers['x-user-email-verified'], 'true');

  res = await app.inject({ url: '/api/media/files' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'UNAUTHORIZED');
  assert.match(String(res.headers['www-authenticate']), /invalid_request/);
  res = await app.inject({ url: '/api/media/files', headers: { authorization: `Bearer ${good}x` } });
  assert.equal(res.json().error.code, 'INVALID');
  res = await app.inject({ url: '/api/media/files', headers: { authorization: `Bearer ${await token({}, { expiresIn: '-1m' })}` } });
  assert.equal(res.json().error.code, 'EXPIRED');
  res = await app.inject({ url: '/api/media/files', headers: { authorization: `Bearer ${await token({}, { issuer: 'https://evil' })}` } });
  assert.equal(res.statusCode, 401);
});

test('CORS: preflight answered locally per route, headers added for allowed origins only', async () => {
  let res = await app.inject({ url: '/api/media/files', method: 'OPTIONS', headers: { origin: 'https://app.test.local', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, x-file-name' } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'https://app.test.local');
  assert.equal(res.headers['access-control-allow-headers'], 'authorization, x-file-name');
  assert.equal(res.headers.vary, 'Origin');
  res = await app.inject({ url: '/api/media/files', method: 'OPTIONS', headers: { origin: 'https://evil.test', 'access-control-request-method': 'PUT' } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  res = await app.inject({ url: '/api/auth/login', method: 'POST', payload: {}, headers: { origin: 'https://anything.test' } });
  assert.equal(res.headers['access-control-allow-origin'], '*');
  res = await app.inject({ url: '/files/x', headers: { origin: 'https://app.test.local' } });
  assert.equal(res.headers['access-control-allow-origin'], undefined, 'route without cors');
  res = await app.inject({ url: '/files/x', method: 'OPTIONS', headers: { origin: 'https://app.test.local', 'access-control-request-method': 'GET' } });
  assert.equal(res.statusCode, 405, 'no cors config → OPTIONS treated like any method');
});

test('body limits: declared and streamed', async () => {
  let res = await app.inject({ url: '/api/auth/login', method: 'POST', payload: Buffer.alloc(20000), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().error.code, 'TOO_LARGE');
  res = await app.inject({ url: '/api/auth/login', method: 'POST', payload: Buffer.alloc(9000), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(res.statusCode, 200);
  const big = await token();
  res = await app.inject({ url: '/api/media/files', method: 'PUT', payload: Buffer.alloc(6000), headers: { authorization: `Bearer ${big}`, 'content-type': 'application/octet-stream' } });
  assert.equal(res.statusCode, 413, 'route override (5000) applies');
});

test('rate limit per route and client IP with headers', async () => {
  const doc = routesDoc({ api: origin(echo), files: origin(echo), auth: origin(echo) });
  doc.routes[0].rateLimit = 2;
  const routes = RouteTable.parse(doc, routesEnv);
  const small = await new GatewayApi({ config: testConfig(), routes, jwt: null, logger: silentLog }).build();
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await small.inject({ url: '/files/x' })).statusCode);
  assert.deepEqual(codes, [200, 200, 429]);
  const last = await small.inject({ url: '/files/x' });
  assert.equal(last.headers['retry-after'] !== undefined, true);
  assert.equal(last.headers['x-ratelimit-remaining'], '0');
  assert.equal((await small.inject({ url: '/other', headers: { host: 'shop.test.local' } })).statusCode, 200, 'other route unaffected');
  await small.close();
});

test('upstream failures: retry safe methods on the next upstream, 502/504 otherwise, passive cooldown', async () => {
  flakyHits = 0;
  let res = await app.inject({ url: '/flaky/x' });
  assert.equal(res.statusCode, 200, 'dead upstream skipped by retry');
  assert.equal(res.body, 'flaky');
  res = await app.inject({ url: '/flaky/x' });
  assert.equal(res.statusCode, 200);
  assert.equal(flakyHits, 2);
  res = await app.inject({ url: '/dead/x' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, 'UPSTREAM_UNREACHABLE');
  res = await app.inject({ url: '/slow/slow' });
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().error.code, 'UPSTREAM_TIMEOUT');
  res = await app.inject({ url: '/dead/x', method: 'POST', payload: 'x' });
  assert.equal(res.statusCode, 502, 'no retry for unsafe methods');
});

test('/ready reports upstream health per route; /metrics needs the token and exposes counters', async () => {
  const ready = await app.inject('/ready');
  assert.equal(ready.statusCode, 503, 'dead route has no healthy upstream');
  assert.equal(ready.json().upstreams.files, '1/1');
  assert.equal(ready.json().upstreams.dead, '0/1');
  assert.equal((await app.inject('/metrics')).statusCode, 401);
  const m = await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${'m'.repeat(40)}` } });
  assert.equal(m.statusCode, 200);
  assert.match(m.body, /gateway_requests_total\{route="files",status="2xx"\} \d+/);
  assert.match(m.body, /gateway_rejected_total\{reason="unauthorized"\} [1-9]/);
  assert.match(m.body, /gateway_upstream_errors_total\{route="dead"\} [1-9]/);
  assert.match(m.body, /gateway_request_duration_ms_bucket\{route="files",le="\+Inf"\}/);
  const off = await new GatewayApi({ config: testConfig(), routes: RouteTable.parse(routesDoc({}), routesEnv), jwt: null, logger: silentLog }).build();
  assert.equal((await off.inject({ url: '/metrics', headers: { authorization: 'Bearer x' } })).statusCode, 404, 'disabled without METRICS_TOKEN');
  await off.close();
});

test('/v1/info reports identity, capabilities and null schemaVersion/serviceCore (gateway has no DB, no service-core dependency)', async () => {
  const res = await app.inject('/v1/info');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    service: 'gateway',
    version: '1.1.0',
    apiVersion: 'v1',
    capabilities: ['jwt-auth', 'rate-limit-policy', 'upstream-health-tracking', 'geo-headers', 'cors', 'trace-propagation'],
    schemaVersion: null,
    serviceCore: null,
    routesRevision: null,
  });
});
