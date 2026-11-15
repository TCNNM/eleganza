import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Accounts } from '../src/accounts.mjs';
import { createEleganzaServer } from '../src/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {} };

async function bootServer(configPayload) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eleganza-api-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify(configPayload));
  const config = loadConfig(file);
  const store = new Store({ config, log: quiet });
  const accounts = new Accounts({ config, dataDir: config.dataDir, log: quiet });
  await accounts.init();
  const server = createEleganzaServer({
    config,
    store,
    accounts,
    publicDir: path.join(root, 'public'),
    log: quiet,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    accounts,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await accounts.close();
    },
  };
}

const baseConfig = {
  dataDir: 'data',
  site: { title: 'Eleganza Test', refreshSeconds: 5, hub: { name: 'Hub', lat: 31, lon: 121 } },
  accounts: { required: false, allowRegistration: false, sessionHours: 168, setupToken: 'test-setup-token' },
  targets: [
    { id: 'tcp', name: 'TCP', type: 'tcp', host: '127.0.0.1', port: 1, intervalSeconds: 30, lat: 1, lon: 2 },
    { id: 'agent', name: 'Agent', type: 'agent', agentKey: 'secret-key', intervalSeconds: 30, lat: 3, lon: 4 },
  ],
};

function cookieFrom(response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

test('public status UI, static assets and agent ingest', async () => {
  const server = await bootServer(baseConfig);
  try {
    const status = await (await fetch(`${server.base}/api/auth/status`)).json();
    assert.equal(status.required, false);
    assert.equal(status.setupRequired, true);
    assert.equal(status.user, null);

    const index = await fetch(`${server.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    assert.match(html, /ELEGANZA/);
    assert.match(html, /appearance-popover/);
    assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
    const etag = index.headers.get('etag');
    assert.equal((await fetch(`${server.base}/`, { headers: { 'if-none-match': etag } })).status, 304);

    const overviewResponse = await fetch(`${server.base}/api/overview`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(overviewResponse.status, 200);
    assert.equal(overviewResponse.headers.get('content-encoding'), 'gzip');
    const overview = await overviewResponse.json();
    assert.equal(overview.summary.total, 2);
    assert.equal(overview.site.title, 'Eleganza Test');

    assert.equal((await fetch(`${server.base}/api/targets/nope`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${server.base}/../server.mjs`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/account`)).status, 401);

    const unauthorized = await fetch(`${server.base}/api/agent/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthorized.status, 401);

    const report = await fetch(`${server.base}/api/agent/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-key' },
      body: JSON.stringify({
        hostname: 'test-box',
        platform: 'Ubuntu 24.04',
        kernel: '6.8.0',
        agentVersion: '1.1.0',
        uptimeSeconds: 3600,
        cpu: { usage: 42.5, cores: 4 },
        memory: { total: 8 * 1024 ** 3, used: 2 * 1024 ** 3 },
        disks: [{ mount: '/', total: 80 * 1024 ** 3, used: 20 * 1024 ** 3 }],
        net: { rxBytes: 1000, txBytes: 500 },
        services: [{ name: 'nginx', active: true }],
        latencyMs: 9.5,
      }),
    });
    assert.equal(report.status, 200);
    assert.equal((await report.json()).hostname, 'test-box');

    const node = await (await fetch(`${server.base}/api/targets/agent?range=24h`)).json();
    assert.equal(node.target.status, 'online');
    assert.equal(node.target.metrics.cpu, 42.5);
    assert.equal(node.services[0].name, 'nginx');

  } finally {
    await server.close();
  }
});

test('account system: setup, login, preferences, admin and access control', async () => {
  const server = await bootServer({
    ...baseConfig,
    site: { ...baseConfig.site, title: 'Private Eleganza' },
    accounts: { required: true, allowRegistration: false, sessionHours: 168, setupToken: 'test-setup-token' },
  });
  try {
    assert.equal((await fetch(`${server.base}/api/overview`)).status, 401);
    const status = await (await fetch(`${server.base}/api/auth/status`)).json();
    assert.equal(status.required, true);
    assert.equal(status.setupRequired, true);
    assert.equal(status.user, null);

    const wrongSetup = await fetch(`${server.base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong', username: 'admin', password: 'password123' }),
    });
    assert.equal(wrongSetup.status, 403);

    const setup = await fetch(`${server.base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-setup-token', username: 'admin', password: 'password123', displayName: 'Admin' }),
    });
    assert.equal(setup.status, 200);
    const adminCookie = cookieFrom(setup);
    const adminUser = (await setup.json()).user;
    assert.equal(adminUser.role, 'admin');
    assert.equal((await fetch(`${server.base}/api/overview`, { headers: { cookie: adminCookie } })).status, 200);

    assert.equal((await fetch(`${server.base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-setup-token', username: 'other', password: 'password123' }),
    })).status, 409);

    const prefs = await fetch(`${server.base}/api/account`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ preferences: { style: 'paper', accent: 'champagne', density: 'compact', effects: false, motion: false } }),
    });
    assert.equal(prefs.status, 200);
    const prefsBody = await prefs.json();
    assert.equal(prefsBody.user.preferences.style, 'paper');
    assert.equal(prefsBody.user.preferences.accent, 'champagne');

    const created = await fetch(`${server.base}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'ops', password: 'ops-password', displayName: 'Ops', role: 'member' }),
    });
    assert.equal(created.status, 201);
    const ops = (await created.json()).user;

    const users = await (await fetch(`${server.base}/api/admin/users`, { headers: { cookie: adminCookie } })).json();
    assert.equal(users.users.length, 2);

    const opsLogin = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ops', password: 'ops-password' }),
    });
    assert.equal(opsLogin.status, 200);
    const opsCookie = cookieFrom(opsLogin);
    assert.equal((await fetch(`${server.base}/api/admin/users`, { headers: { cookie: opsCookie } })).status, 403);
    assert.equal((await fetch(`${server.base}/api/overview`, { headers: { cookie: opsCookie } })).status, 200);

    const disabled = await fetch(`${server.base}/api/admin/users/${ops.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disabled.status, 200);
    assert.equal((await fetch(`${server.base}/api/overview`, { headers: { cookie: opsCookie } })).status, 401);
    assert.equal((await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ops', password: 'ops-password' }),
    })).status, 401);

    const selfDemote = await fetch(`${server.base}/api/admin/users/${adminUser.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(selfDemote.status, 409);

    const deleted = await fetch(`${server.base}/api/admin/users/${ops.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    assert.equal(deleted.status, 200);

    // cross-origin writes are rejected
    assert.equal((await fetch(`${server.base}/api/account`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'https://evil.example' },
      body: JSON.stringify({ displayName: 'x' }),
    })).status, 403);

    assert.equal((await fetch(`${server.base}/api/auth/logout`, { method: 'POST', headers: { cookie: adminCookie } })).status, 200);
    assert.equal((await fetch(`${server.base}/api/overview`, { headers: { cookie: adminCookie } })).status, 401);

    assert.equal((await fetch(`${server.base}/mcp`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/mcp`)).status, 401);

    assert.equal((await fetch(`${server.base}/`)).status, 200);
  } finally {
    await server.close();
  }
});
