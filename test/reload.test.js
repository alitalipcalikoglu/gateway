import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Application } from '../src/application.js';
import { RouteTable } from '../src/route-table.js';
import { capturingLog, testConfig } from './helpers.js';

/** @param {import('node:http').Server} s */
const origin = (s) => `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (s.address()).port}`;
/** @param {import('node:http').Server} s */
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));

/** @param {string} routeId @param {string} upstreamOrigin */
const docWith = (routeId, upstreamOrigin) => JSON.stringify({ routes: [{ id: routeId, pathPrefix: '/x/', upstreams: [upstreamOrigin] }] });

const REVISION_RE = /^\d+(\.\d+)?-[0-9a-f]{16}$/;

let dir = '';
before(() => { dir = mkdtempSync(join(tmpdir(), 'gateway-reload-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

test('good reload: a valid new routes.json swaps in atomically, routesRevision changes, new requests use the new config', async () => {
  const oldBackend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('OLD-BACKEND'); });
  const newBackend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('NEW-BACKEND'); });
  await Promise.all([listen(oldBackend), listen(newBackend)]);
  const routesFile = join(dir, 'good.json');
  writeFileSync(routesFile, docWith('x', origin(oldBackend)));
  const application = new Application(testConfig({ ROUTES_FILE: routesFile }), RouteTable.load(routesFile));
  const app = await application.api.build();
  await app.ready();
  try {
    assert.equal((await app.inject('/x/a')).body, 'OLD-BACKEND');
    const before_ = application.api.routesRevision;

    writeFileSync(routesFile, docWith('x', origin(newBackend)));
    const { log, calls } = capturingLog();
    await application.reload(log);

    assert.match(/** @type {string} */ (application.api.routesRevision), REVISION_RE);
    assert.notEqual(application.api.routesRevision, before_, 'revision changes on a successful reload');
    assert.ok(calls.some((c) => c.level === 'info' && /** @type {any} */ (c.args[1]) === 'routes reloaded'));
    assert.equal((await app.inject('/x/b')).body, 'NEW-BACKEND', 'a new request uses the new config');
  } finally { await app.close(); application.api.destroy(); oldBackend.close(); newBackend.close(); }
});

test('bad reload: invalid JSON is refused, keeps serving the previous configuration unchanged, routesRevision untouched, logs a structured error — never crashes', async () => {
  const backend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('STILL-OLD'); });
  await listen(backend);
  const routesFile = join(dir, 'bad.json');
  writeFileSync(routesFile, docWith('x', origin(backend)));
  const application = new Application(testConfig({ ROUTES_FILE: routesFile }), RouteTable.load(routesFile));
  const app = await application.api.build();
  await app.ready();
  try {
    const revisionBefore = application.api.routesRevision;
    writeFileSync(routesFile, '{ this is not valid json');
    const { log, calls } = capturingLog();
    await application.reload(log);
    assert.equal(application.api.routesRevision, revisionBefore, 'unchanged — a bad reload never moves the revision forward');
    assert.equal((await app.inject('/x/a')).body, 'STILL-OLD', 'still serving the previous, good configuration');
    const err = calls.find((c) => c.level === 'error');
    assert.ok(err, 'a structured error is logged');
    assert.match(String(/** @type {any} */ (err?.args[1])), /reload failed/);
  } finally { await app.close(); application.api.destroy(); backend.close(); }
});

test('bad reload: a route that newly needs an unconfigured integration is refused just like at startup', async () => {
  const backend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('OLD'); });
  await listen(backend);
  const routesFile = join(dir, 'integration.json');
  writeFileSync(routesFile, docWith('x', origin(backend)));
  const application = new Application(testConfig({ ROUTES_FILE: routesFile }), RouteTable.load(routesFile));
  const app = await application.api.build();
  await app.ready();
  try {
    writeFileSync(routesFile, JSON.stringify({ routes: [{ id: 'x', pathPrefix: '/x/', upstreams: [origin(backend)], policy: { name: 'api', subject: 'ip', failOpen: true } }] }));
    const { log, calls } = capturingLog();
    await application.reload(log);
    const err = calls.find((c) => c.level === 'error');
    assert.match(String(/** @type {any} */ (err?.args[0])?.err), /need RATELIMIT_URL/);
    assert.equal((await app.inject('/x/a')).body, 'OLD', 'previous config still serving');
  } finally { await app.close(); application.api.destroy(); backend.close(); }
});

test('in-flight isolation: a request already being served completes against its OLD route/pool, unaffected by a reload that lands mid-flight; a new request immediately after uses the NEW config', async () => {
  /** @type {import('node:http').ServerResponse|null} */
  let held = null;
  /** @type {() => void} */
  let heldReceived = () => {};
  const heldPromise = new Promise((r) => { heldReceived = () => r(undefined); });
  const oldBackend = createServer((req, res) => {
    if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok');
    held = res;
    heldReceived();
  });
  const newBackend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('NEW-BACKEND'); });
  await Promise.all([listen(oldBackend), listen(newBackend)]);
  const routesFile = join(dir, 'inflight.json');
  writeFileSync(routesFile, docWith('x', origin(oldBackend)));
  const application = new Application(testConfig({ ROUTES_FILE: routesFile }), RouteTable.load(routesFile));
  const app = await application.api.build();
  await app.ready();
  try {
    // Request A starts, reaches the old backend, and is held open — genuinely in flight through
    // the gateway (Proxy is awaiting its response) for the whole rest of this test.
    const pA = app.inject('/x/a');
    await heldPromise;

    // A reload lands while A is still in flight.
    writeFileSync(routesFile, docWith('x', origin(newBackend)));
    await application.reload();

    // Request B, issued after the reload, must use the NEW config.
    const resB = await app.inject('/x/b');
    assert.equal(resB.body, 'NEW-BACKEND');

    // Only now release A's held response — it must complete successfully against the OLD backend,
    // proving it kept its own reference to the old route/pool throughout, never repointed mid-flight.
    assert.ok(held);
    /** @type {import('node:http').ServerResponse} */ (held).writeHead(200).end('OLD-BACKEND');
    const resA = await pA;
    assert.equal(resA.statusCode, 200);
    assert.equal(resA.body, 'OLD-BACKEND', 'the in-flight request completed against its original backend, socket never dropped');
  } finally { await app.close(); application.api.destroy(); oldBackend.close(); newBackend.close(); }
});

test('overlapping SIGHUP (coalescing): a reload that arrives while one is already in flight is coalesced into exactly one more pass, never run concurrently', async () => {
  const backend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('ok'); });
  await listen(backend);
  const routesFile = join(dir, 'coalesce.json');
  writeFileSync(routesFile, docWith('x', origin(backend)));
  const application = new Application(testConfig({ ROUTES_FILE: routesFile }), RouteTable.load(routesFile));
  const app = await application.api.build();
  await app.ready();
  try {
    const { log, calls } = capturingLog();
    const p1 = application.reload(log);
    assert.equal(application.reloading, true, 'the first call already claimed the in-flight flag synchronously');
    const p2 = application.reload(log);
    await Promise.all([p1, p2]);
    assert.equal(application.reloading, false);
    const reloaded = calls.filter((c) => c.level === 'info' && c.args[1] === 'routes reloaded');
    const coalesced = calls.filter((c) => c.level === 'info' && String(c.args[0]).includes('coalescing'));
    assert.equal(reloaded.length, 2, 'the second call\'s work still actually ran — as one more pass, not dropped');
    assert.equal(coalesced.length, 1, 'the second call signaled coalescing exactly once, never started its own overlapping pass');
  } finally { await app.close(); application.api.destroy(); backend.close(); }
});

test('SIGHUP after shutdown is a no-op', async () => {
  const backend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('ok'); });
  await listen(backend);
  const routesFile = join(dir, 'shutdown.json');
  writeFileSync(routesFile, docWith('x', origin(backend)));
  const application = new Application(testConfig({ ROUTES_FILE: routesFile }), RouteTable.load(routesFile));
  const app = await application.api.build();
  await app.ready();
  application.app = app;
  application.shuttingDown = true;
  const { log, calls } = capturingLog();
  await application.reload(log);
  assert.equal(calls.length, 0, 'no work attempted once shutting down');
  application.shuttingDown = false;
  await app.close();
  application.api.destroy();
  backend.close();
});

test('/v1/info reflects the current routesRevision; a fresh, never-reloaded instance reports null', async () => {
  const backend = createServer((req, res) => { if ((req.url ?? '').endsWith('/health')) return res.writeHead(200).end('ok'); res.writeHead(200).end('ok'); });
  await listen(backend);
  const routesFile = join(dir, 'info.json');
  writeFileSync(routesFile, docWith('x', origin(backend)));
  const application = new Application(testConfig({ ROUTES_FILE: routesFile }), RouteTable.load(routesFile));
  const app = await application.api.build();
  await app.ready();
  try {
    assert.equal((await app.inject('/v1/info')).json().routesRevision, null);
    await application.reload();
    assert.match((await app.inject('/v1/info')).json().routesRevision, REVISION_RE);
  } finally { await app.close(); application.api.destroy(); backend.close(); }
});
