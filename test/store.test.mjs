import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { DAY, HOUR } from '../src/util.mjs';

async function makeStore(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'polaris-store-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({
    dataDir: 'data',
    site: { title: 'Test', refreshSeconds: 10, showAddress: false },
    thresholds: { failureThreshold: 2 },
    targets: [
      { id: 'web', name: 'Web', type: 'https', url: 'https://example.com/', lat: 1, lon: 2, intervalSeconds: 10 },
      { id: 'agent', name: 'Agent', type: 'agent', agentKey: 'agent-key', lat: 3, lon: 4, intervalSeconds: 10 },
    ],
    ...extra,
  }));
  const config = loadConfig(file);
  const store = new Store({ config, log: { info() {}, warn() {} } });
  return { store, config, dir };
}

test('records samples, opens and closes incidents', async () => {
  const { store } = await makeStore();
  const now = Date.now();
  store.recordSample('web', { t: now - 3000, ok: true, latencyMs: 42 });
  assert.equal(store.targets.get('web').status, 'online');

  store.recordSample('web', { t: now - 2000, ok: false, error: '连接超时' });
  assert.equal(store.targets.get('web').status, 'online', 'debounces the first failure');
  store.recordSample('web', { t: now - 1000, ok: false, error: '连接超时' });
  assert.equal(store.targets.get('web').status, 'offline');
  assert.equal(store.incidents.length, 1);
  assert.equal(store.incidents[0].endedAt, null);

  store.recordSample('web', { t: now, ok: true, latencyMs: 30 });
  assert.equal(store.targets.get('web').status, 'online');
  assert.ok(store.incidents[0].endedAt);
  assert.equal(store.incidents[0].durationMs, 1000);

  const overview = store.overview(now);
  const web = overview.targets.find((target) => target.id === 'web');
  assert.equal(web.availability30d, 50);
  assert.equal(web.sparkline.length, 4);
  assert.equal(web.daily.at(-1).up, 2);
  assert.equal(web.endpoint, 'e***.com:443');

  const detail = store.detail('web', '1h', now);
  assert.equal(detail.points.length, 4);
  assert.equal(detail.incidents.length, 1);
});

test('agent reports update metrics, services and rates', async () => {
  const { store } = await makeStore();
  const now = Date.now();
  store.recordAgent('agent', {
    hostname: 'sg-test',
    platform: 'Ubuntu 24.04',
    kernel: '6.8.0',
    agentVersion: '1.0.0',
    uptimeSeconds: 86400,
    cpu: { usage: 37.5, cores: 4 },
    memory: { total: 8 * 1024 ** 3, used: 2 * 1024 ** 3 },
    disks: [{ mount: '/', total: 80 * 1024 ** 3, used: 20 * 1024 ** 3 }],
    net: { rxBytes: 1_000_000, txBytes: 500_000 },
    services: [{ name: 'nginx', active: true }, { name: 'xray', active: false }],
    latencyMs: 12.5,
  }, now);

  const state = store.targets.get('agent');
  assert.equal(state.status, 'online');
  assert.equal(state.metrics.cpu, 37.5);
  assert.equal(state.metrics.mem, 25);
  assert.equal(state.metrics.disk, 25);
  assert.equal(state.services.length, 2);
  assert.equal(store.overview(now).targets.find((target) => target.id === 'agent').latencyMs, 12.5);

  store.recordAgent('agent', {
    hostname: 'sg-test',
    cpu: { usage: 40, cores: 4 },
    memory: { total: 8 * 1024 ** 3, used: 3 * 1024 ** 3 },
    disks: [{ mount: '/', total: 80 * 1024 ** 3, used: 24 * 1024 ** 3 }],
    net: { rxBytes: 1_600_000, txBytes: 800_000 },
    latencyMs: 14,
  }, now + 60_000);
  assert.equal(state.metrics.net.rxRate, 10_000);
  assert.equal(state.metrics.net.txRate, 5_000);
});

test('marks silent agents offline after the stale threshold', async () => {
  const { store } = await makeStore();
  const now = Date.now();
  store.recordAgent('agent', {
    hostname: 'sg-test',
    cpu: { usage: 10 },
    memory: { total: 100, used: 40 },
    disks: [{ mount: '/', total: 100, used: 20 }],
  }, now);
  assert.equal(store.targets.get('agent').status, 'online');
  store.sweep(now + 91_000);
  assert.equal(store.targets.get('agent').status, 'offline');
  assert.ok(store.incidents.some((incident) => incident.targetId === 'agent' && !incident.endedAt));
});

test('builds 30 day availability levels from hourly buckets', async () => {
  const { store } = await makeStore();
  const now = Date.now();
  const base = new Date(now);
  const dayStart = (offset) => new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset).getTime();
  const hourOf = (dayOffset, hours = 1) => Math.floor((dayStart(dayOffset) + hours * HOUR) / HOUR);
  store.seededBuckets('web', [
    { hour: hourOf(1), up: 180, total: 180, latSum: 180 * 20, latN: 180 },
    { hour: hourOf(2), up: 172, total: 180, latSum: 172 * 30, latN: 172 },
    { hour: hourOf(3), up: 100, total: 180, latSum: 100 * 60, latN: 100 },
  ]);
  const daily = store.targets.get('web');
  const series = store.dailySeries(daily, 30, now);
  assert.equal(series.length, 30);
  assert.equal(series.at(-2).level, 'up');
  assert.equal(series.at(-3).level, 'partial');
  assert.equal(series.at(-4).level, 'down');
  assert.equal(series.at(-1).level, 'empty');
});

test('persists and restores state across restarts', async () => {
  const { store, config } = await makeStore();
  const now = Date.now();
  store.recordSample('web', { t: now - 60_000, ok: true, latencyMs: 31, tls: { daysLeft: 40, issuer: 'R11' } });
  store.recordSample('web', { t: now - 30_000, ok: false, error: 'boom' });
  store.recordSample('web', { t: now - 20_000, ok: false, error: 'boom' });
  await store.save();

  const restored = new Store({ config, log: { info() {}, warn() {} } });
  const loaded = await restored.load();
  assert.equal(loaded, true);
  const state = restored.targets.get('web');
  assert.equal(state.status, 'offline');
  assert.equal(state.error, 'boom');
  assert.equal(state.samples.length, 3);
  assert.equal(state.tls.daysLeft, 40);
  assert.equal(restored.incidents.length, 1);
  assert.ok(state.buckets.size >= 1);
  assert.equal(restored.overview(now).targets.find((target) => target.id === 'web').status, 'offline');
});

test('prunes buckets older than the retention window', async () => {
  const { store } = await makeStore();
  const now = Date.now();
  const oldHour = Math.floor((now - 40 * DAY) / HOUR);
  const recentHour = Math.floor((now - 1 * HOUR) / HOUR);
  store.seededBuckets('web', [
    { hour: oldHour, up: 1, total: 1 },
    { hour: recentHour, up: 1, total: 1 },
  ]);
  store.pruneBuckets(now);
  assert.equal(store.targets.get('web').buckets.has(oldHour), false);
  assert.equal(store.targets.get('web').buckets.has(recentHour), true);
});
