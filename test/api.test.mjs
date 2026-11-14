import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Auth } from '../src/auth.mjs';
import { McpServer } from '../src/mcp.mjs';
import { createPolarisServer } from '../src/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function bootServer(configPayload) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polaris-api-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify(configPayload));
  const config = loadConfig(file);
  const store = new Store({ config, log: { info() {}, warn() {}, error() {} } });
  const auth = new Auth({ config, dataDir: config.dataDir, log: { info() {}, warn() {} } });
  await auth.init();
  const mcp = new McpServer({ store, config });
  const server = createPolarisServer({
    config,
    store,
    auth,
    mcp,
    publicDir: path.join(root, 'public'),
    log: { error() {}, info() {}, warn() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const baseConfig = {
  dataDir: 'data',
  site: { title: 'Polaris Test', refreshSeconds: 5, public: true, hub: { name: 'Hub', lat: 31, lon: 121 } },
  targets: [
    { id: 'tcp', name: 'TCP', type: 'tcp', host: '127.0.0.1', port: 1, intervalSeconds: 30, lat: 1, lon: 2 },
    { id: 'agent', name: 'Agent', type: 'agent', agentKey: 'secret-key', intervalSeconds: 30, lat: 3, lon: 4 },
  ],
};

test('public API, static assets, agent ingest and MCP', async () => {
  const server = await bootServer(baseConfig);
  try {
    const health = await (await fetch(`${server.base}/api/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.nodes, 2);

    const index = await fetch(`${server.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /POLARIS/);
    assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
    const etag = index.headers.get('etag');
    const cached = await fetch(`${server.base}/`, { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304);

    const overviewResponse = await fetch(`${server.base}/api/overview`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(overviewResponse.status, 200);
    assert.equal(overviewResponse.headers.get('content-encoding'), 'gzip');
    const overview = await overviewResponse.json();
    assert.equal(overview.summary.total, 2);
    assert.equal(overview.targets.length, 2);
    assert.equal(overview.site.title, 'Polaris Test');

    assert.equal((await fetch(`${server.base}/api/targets/nope`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${server.base}/../server.mjs`)).status, 404);

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
        agentVersion: '1.0.0',
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

    const init = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    });
    assert.equal(init.status, 200);
    const initBody = await init.json();
    assert.equal(initBody.result.serverInfo.name, 'polaris');

    const tools = await (await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })).json();
    assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['overview', 'list_nodes', 'get_node', 'get_history', 'list_incidents']);

    const call = await (await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_node', arguments: { node_id: 'agent' } } }),
    })).json();
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0].text, /test-box/);

    const meta = await (await fetch(`${server.base}/mcp`)).json();
    assert.equal(meta.endpoint, '/mcp');

    const notification = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(notification.status, 202);
  } finally {
    await server.close();
  }
});

test('private mode requires login and supports bearer MCP access', async () => {
  const server = await bootServer({
    ...baseConfig,
    site: { ...baseConfig.site, public: false },
    auth: { password: 'correct horse battery staple', mcpToken: 'mcp-secret' },
  });
  try {
    assert.equal((await fetch(`${server.base}/api/overview`)).status, 401);
    const session = await (await fetch(`${server.base}/api/session`)).json();
    assert.equal(session.required, true);
    assert.equal(session.authenticated, false);

    const wrong = await fetch(`${server.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${server.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    assert.match(cookie, /polaris_session=/);

    const authorized = await fetch(`${server.base}/api/overview`, { headers: { cookie } });
    assert.equal(authorized.status, 200);

    const tampered = await fetch(`${server.base}/api/overview`, { headers: { cookie: 'polaris_session=1.bad' } });
    assert.equal(tampered.status, 401);

    assert.equal((await fetch(`${server.base}/mcp`)).status, 401);
    assert.equal((await fetch(`${server.base}/mcp`, { headers: { authorization: 'Bearer mcp-secret' } })).status, 200);
    assert.equal((await fetch(`${server.base}/mcp`, { headers: { authorization: 'Bearer nope' } })).status, 401);

    // static assets stay reachable so the login screen can boot
    assert.equal((await fetch(`${server.base}/`)).status, 200);
  } finally {
    await server.close();
  }
});
