import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

/** A free TCP port picked by the OS, released immediately for the child process to bind instead. */
async function freePort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
  await new Promise((resolve) => srv.close(() => resolve(undefined)));
  return port;
}

/**
 * Stage 9, item 15: the SIGHUP wiring end to end — a REAL OS signal, sent to a REAL separate
 * process (never this test runner's own process, so there is no risk of leaking a stray
 * `process.on('SIGHUP', ...)` listener into every other test file in this suite). Everything else
 * about reload (coalescing, bad-file handling, in-flight isolation, routesRevision) is already
 * proven deterministically at the `Application#reload()` level in reload.test.js; this one test's
 * only job is confirming the signal itself is actually wired up to that same code path, and that a
 * second, unrelated signal (SIGTERM) still shuts the process down cleanly afterward — i.e. one
 * signal handler never interferes with another for the lifetime of one process.
 */
const dir = mkdtempSync(join(tmpdir(), 'gateway-sighup-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Uses the real, unmodified \`Application.start()\` — the exact same code path \`index.js\` runs in
// production, including its own \`#installSignalHandlers\` wiring SIGHUP/SIGTERM. Nothing here
// re-implements or bypasses that wiring.
const FIXTURE = `
import { Application } from ${JSON.stringify(fileURLToPath(new URL('../src/application.js', import.meta.url)))};
const application = Application.fromEnv();
await application.start();
console.log('LISTENING', application.app.server.address().port);
`;

test('SIGHUP end to end: a real signal to a real process triggers a real reload; SIGTERM afterward still shuts it down cleanly', async () => {
  const routesFile = join(dir, 'routes.json');
  writeFileSync(routesFile, JSON.stringify({ routes: [{ id: 'x', pathPrefix: '/x/', upstreams: ['http://127.0.0.1:1'] }] }));
  const fixture = join(dir, 'fixture.mjs');
  writeFileSync(fixture, FIXTURE);

  const port = await freePort();
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, ROUTES_FILE: routesFile, LOG_LEVEL: 'info', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`process never became ready:\n${out}\n${err}`)), 5000);
      const check = () => { if (/LISTENING \d+/.test(out)) { clearTimeout(timer); resolve(undefined); } };
      child.stdout.on('data', check);
      check();
    });

    child.kill('SIGHUP');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "routes reloaded" log line within 5s:\n${out}\n${err}`)), 5000);
      const check = () => { if (/"routes reloaded"/.test(out)) { clearTimeout(timer); resolve(undefined); } };
      child.stdout.on('data', check);
      check();
    });

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.kill('SIGTERM');
    });
    assert.equal(exitCode, 0, `clean exit after SIGTERM following a SIGHUP reload; stderr:\n${err}`);
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
});
