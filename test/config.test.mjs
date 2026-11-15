import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

async function writeConfig(payload) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eleganza-config-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify(payload));
  return file;
}

const base = {
  site: { title: 'Test', hub: { name: 'Hub', lat: 31.2, lon: 121.4 } },
  targets: [
    { id: 'web', name: 'Web', type: 'https', url: 'https://example.com/', lat: 1, lon: 2 },
    { id: 'agent', name: 'Agent', type: 'agent', agentKey: 'secret-key', lat: 3, lon: 4 },
  ],
};

test('loadConfig applies defaults and normalises targets', async () => {
  const file = await writeConfig(base);
  const config = loadConfig(file);
  assert.equal(config.site.title, 'Test');
  assert.equal(config.site.refreshSeconds, 10);
  assert.equal(config.accounts.required, false);
  assert.equal(config.accounts.sessionHours, 168);
  assert.equal(config.accounts.allowRegistration, false);
  assert.equal(config.auth.mcpToken, '');
  assert.equal(config.targets.length, 2);
  const web = config.targets[0];
  assert.equal(web.type, 'https');
  assert.equal(web.port, 443);
  assert.equal(web.intervalSeconds, 10);
  assert.equal(web.host, 'example.com');
  assert.equal(web.thresholds.failureThreshold, 2);
  assert.equal(config.targets[1].agentKey, 'secret-key');
  assert.equal(config.targets[1].port, undefined);
});

test('loadConfig rejects unknown types and duplicate ids', async () => {
  const badType = await writeConfig({ targets: [{ id: 'a', type: 'icmp', host: 'x' }] });
  assert.throws(() => loadConfig(badType), /不支持/);

  const duplicate = await writeConfig({
    targets: [
      { id: 'a', type: 'tcp', host: '127.0.0.1', port: 1 },
      { id: 'a', type: 'tcp', host: '127.0.0.1', port: 2 },
    ],
  });
  assert.throws(() => loadConfig(duplicate), /重复/);
});

test('accounts.required follows site.public for compatibility', async () => {
  const legacy = loadConfig(await writeConfig({ site: { public: false }, targets: [] }));
  assert.equal(legacy.accounts.required, true);

  const explicit = loadConfig(await writeConfig({ accounts: { required: true, allowRegistration: true }, targets: [] }));
  assert.equal(explicit.accounts.required, true);
  assert.equal(explicit.accounts.allowRegistration, true);
});

test('loadConfig requires an agent key outside demo mode', async () => {
  const missing = await writeConfig({ targets: [{ id: 'agent', type: 'agent' }] });
  assert.throws(() => loadConfig(missing), /agentKey/);

  const config = loadConfig(missing, { demo: true });
  assert.ok(config.targets[0].agentKey.startsWith('demo-'));
});

test('loadConfig clamps intervals, timeouts and coordinates', async () => {
  const file = await writeConfig({
    site: { refreshSeconds: 1 },
    targets: [{
      id: 't', type: 'tcp', host: 'example.com', port: 443,
      intervalSeconds: 1, timeoutMs: 99999, lat: 120, lon: 400,
    }],
  });
  const config = loadConfig(file);
  assert.equal(config.site.refreshSeconds, 5);
  assert.equal(config.targets[0].intervalSeconds, 5);
  assert.equal(config.targets[0].timeoutMs, 30000);
  assert.equal(config.targets[0].lat, 85);
  assert.equal(config.targets[0].lon, 40);
});
