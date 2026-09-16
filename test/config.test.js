import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { RouteTable } from '../src/route-table.js';
import { UpstreamPool } from '../src/upstream-pool.js';
import { routesDoc, routesEnv, testConfig, testRoutes } from './helpers.js';

test('Config defaults and validation', () => {
  const c = testConfig();
  assert.equal(c.port, 3000);
  assert.equal(c.rateLimitMax, 300);
  assert.equal(c.hstsMaxAge, 0);
  assert.equal(c.metricsToken, null);
  assert.equal(testConfig({ TLS_CERT_PATH: '/c', TLS_KEY_PATH: '/k' }).hstsMaxAge, 31_536_000, 'HSTS on by default with TLS');
  for (const o of [{ TLS_CERT_PATH: '/c' }, { METRICS_TOKEN: 'short' }, { PORT: 'x' }, { SERVER_NAME: 'bad name!' }, { UPSTREAM_TIMEOUT_MS: '10' }]) {
    assert.throws(() => Config.fromEnv({ ROUTES_FILE: '/dev/null', ...o }), ConfigError, JSON.stringify(o));
  }
});

test('RouteTable parses, resolves secrets, orders by specificity and matches', () => {
  const t = testRoutes({ api: 'http://10.0.0.5:3003/' });
  assert.deepEqual(t.routes.map((r) => r.id), ['media-api', 'auth-api', 'files', 'site'], 'longest prefix first');
  const media = t.routes[0];
  assert.equal(media.injectApiKey, routesEnv.MEDIA_API_KEY, 'secret resolved from env, not stored by name');
  assert.deepEqual(media.upstreams, ['http://10.0.0.5:3003'], 'trailing slash normalised to origin');
  assert.equal(media.auth, 'user');
  assert.equal(t.routes[2].auth, 'none');
  assert.deepEqual(t.routes[1].methods, ['POST', 'OPTIONS']);

  assert.equal(t.match('gw.test.local', '/api/media/files/abc')?.id, 'media-api');
  assert.equal(t.match('gw.test.local', '/api/media')?.id, 'media-api', 'bare prefix matches');
  assert.equal(t.match('gw.test.local', '/api/mediax')?.id, undefined, 'no partial segment match');
  assert.equal(t.match('gw.test.local:8443', '/files/x/original')?.id, 'files');
  assert.equal(t.match('SHOP.test.local', '/anything')?.id, 'site', 'host match is case-insensitive');
  assert.equal(t.match('gw.test.local', '/anything'), undefined, 'catch-all bound to a host');

  assert.equal(RouteTable.rewrite(media, '/api/media/files/abc'), '/files/abc');
  assert.equal(RouteTable.rewrite(media, '/api/media'), '/');
  assert.equal(RouteTable.rewrite(t.routes[2], '/files/abc'), '/files/abc', 'no strip');
});

test('RouteTable rejects broken documents', () => {
  /** @param {(d: any) => void} mutate */
  const bad = (mutate, /** @type {NodeJS.ProcessEnv} */ env = routesEnv) => {
    const d = /** @type {any} */ (routesDoc({}));
    mutate(d);
    assert.throws(() => RouteTable.parse(d, env), ConfigError);
  };
  bad((d) => { d.routes = []; });
  bad((d) => { d.routes[0].id = 'Files'; });
  bad((d) => { d.routes[0].pathPrefix = 'files/'; });
  bad((d) => { d.routes[0].pathPrefix = '/../x'; });
  bad((d) => { d.routes[1].stripPrefix = '/other'; });
  bad((d) => { d.routes[0].upstreams = ['http://h:1/path']; });
  bad((d) => { d.routes[0].upstreams = ['ftp://h:1']; });
  bad((d) => { d.routes[0].upstreams = []; });
  bad((d) => { d.routes[0].methods = ['TRACE']; });
  bad((d) => { d.routes[1].auth = 'admin'; });
  bad((d) => { d.routes[1].injectApiKey = 'lowercase'; });
  bad((d) => { d.routes[1].cors = ['app.test.local']; });
  bad((d) => { d.routes[1].rateLimit = 0; });
  bad((d) => { d.routes[1].id = 'files'; });
  bad((d) => { d.routes[2].pathPrefix = '/files/'; }, routesEnv);
  bad((d) => { delete d.jwt; }, routesEnv);
  bad(() => {}, { MEDIA_API_KEY: 'short', AUTH_API_KEY: routesEnv.AUTH_API_KEY });
  bad(() => {}, { AUTH_API_KEY: routesEnv.AUTH_API_KEY });
  assert.throws(() => RouteTable.load('/nonexistent/routes.json'), /cannot read/);
});

test('UpstreamPool round-robins, skips cooled-down upstreams and falls back when all are down', () => {
  const pool = new UpstreamPool(['http://a:1', 'http://b:1', 'http://c:1'], { connectTimeoutMs: 100, cooldownMs: 1000 });
  const seq = () => pool.next({ now: 0 })?.origin;
  assert.deepEqual([seq(), seq(), seq(), seq()], ['http://a:1', 'http://b:1', 'http://c:1', 'http://a:1']);
  const b = pool.upstreams[1];
  b.markDown(1000, 0);
  const three = [pool.next({ now: 0 }), pool.next({ now: 0 }), pool.next({ now: 0 })].map((u) => u?.origin);
  assert.ok(!three.includes('http://b:1'), 'down upstream skipped');
  assert.ok(three.includes('http://a:1') && three.includes('http://c:1'));
  assert.ok([...Array(3)].map(() => pool.next({ now: 1001 })?.origin).includes('http://b:1'), 'back after cooldown');
  assert.equal(pool.next({ exclude: [pool.upstreams[0], pool.upstreams[2]], now: 0 })?.origin, 'http://b:1', 'excluded healthy ones → falls back to the down one');
  for (const u of pool.upstreams) u.markDown(1000, 0);
  assert.ok(pool.next({ now: 0 }), 'all down still yields one');
  pool.destroy();
});

test('RateLimiter counts per key within a minute window', () => {
  const rl = new RateLimiter();
  let r = rl.hit('ip1', 2, 0);
  assert.deepEqual([r.allowed, r.remaining], [true, 1]);
  r = rl.hit('ip1', 2, 10);
  assert.deepEqual([r.allowed, r.remaining], [true, 0]);
  r = rl.hit('ip1', 2, 20);
  assert.deepEqual([r.allowed, r.remaining, r.retryAfterSec], [false, 0, 60]);
  assert.equal(rl.hit('ip2', 2, 20).allowed, true, 'independent keys');
  assert.equal(rl.hit('ip1', 2, 60_000).allowed, true, 'window reset');
  rl.hit('old', 1, 0);
  rl.hit('x', 1, 200_000);
  assert.equal(rl.size, 1, 'expired buckets swept, only the fresh key remains');
});
