import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Notifier } from '../src/notify.mjs';

let hook;
let port;
const received = [];

before(async () => {
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  port = hook.address().port;
});

after(async () => {
  await new Promise((resolve) => hook.close(resolve));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('posts incident webhooks on failure and recovery', async () => {
  received.length = 0;
  const dir = await mkdtemp(path.join(tmpdir(), 'polaris-notify-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({
    site: { title: 'Notify Test', public: true },
    notifications: { webhookUrl: `http://127.0.0.1:${port}/hook` },
    targets: [{ id: 'web', name: 'Web', type: 'https', url: 'https://example.com/', lat: 1, lon: 2 }],
  }));
  const config = loadConfig(file);
  const store = new Store({ config, log: { info() {}, warn() {} } });
  const notifier = new Notifier({ config, log: { warn() {} } });
  store.onEvent((event, incident, node) => notifier.send(event, incident, node));

  const now = Date.now();
  store.recordSample('web', { t: now - 3000, ok: true, latencyMs: 20 });
  store.recordSample('web', { t: now - 2000, ok: false, error: '连接超时' });
  store.recordSample('web', { t: now - 1000, ok: false, error: '连接超时' });

  for (let i = 0; i < 40 && received.length < 1; i += 1) await sleep(50);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.event, 'incident.opened');
  assert.equal(received[0].body.node.name, 'Web');
  assert.equal(received[0].body.incident.error, '连接超时');
  assert.equal(received[0].headers['user-agent'], 'Polaris-Notifier/1.0');

  store.recordSample('web', { t: now, ok: true, latencyMs: 18 });
  for (let i = 0; i < 40 && received.length < 2; i += 1) await sleep(50);
  assert.equal(received.length, 2);
  assert.equal(received[1].body.event, 'incident.resolved');
  assert.ok(received[1].body.incident.durationMs >= 1000);
});

test('respects notifyOnRecovery = false', async () => {
  received.length = 0;
  const dir = await mkdtemp(path.join(tmpdir(), 'polaris-notify-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({
    site: { title: 'Notify Test', public: true },
    notifications: { webhookUrl: `http://127.0.0.1:${port}/hook`, notifyOnRecovery: false },
    targets: [{ id: 'web', name: 'Web', type: 'https', url: 'https://example.com/', lat: 1, lon: 2 }],
  }));
  const config = loadConfig(file);
  const store = new Store({ config, log: { info() {}, warn() {} } });
  const notifier = new Notifier({ config, log: { warn() {} } });
  store.onEvent((event, incident, node) => notifier.send(event, incident, node));

  const now = Date.now();
  store.recordSample('web', { t: now - 2000, ok: false, error: 'down' });
  store.recordSample('web', { t: now - 1000, ok: false, error: 'down' });
  store.recordSample('web', { t: now, ok: true, latencyMs: 18 });
  await sleep(400);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.event, 'incident.opened');
});
