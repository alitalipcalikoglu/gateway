import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GatewayApi } from '../src/http/gateway-api.js';
import { RouteTable } from '../src/route-table.js';
import { routesDoc, routesEnv, silentLog, testConfig } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'gateway-tls-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('serves HTTPS with HSTS when TLS_CERT_PATH and TLS_KEY_PATH are set', async () => {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const config = testConfig({ TLS_CERT_PATH: cert, TLS_KEY_PATH: key });
  const api = new GatewayApi({ config, routes: RouteTable.parse(routesDoc({}), routesEnv), jwt: null, logger: silentLog });
  const app = await api.build();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const addr = /** @type {import('node:net').AddressInfo} */ (app.server.address());
    const result = await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: addr.port, path: '/health', agent: new Agent({ rejectUnauthorized: false }) }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data, hsts: res.headers['strict-transport-security'], tls: /** @type {import('node:tls').TLSSocket} */ (res.socket).encrypted }));
      }).on('error', reject).end();
    });
    assert.deepEqual(result, { status: 200, data: '{"status":"ok"}', hsts: 'max-age=31536000; includeSubDomains', tls: true });
  } finally {
    await app.close();
    api.destroy();
  }
});
