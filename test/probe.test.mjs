import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { probeHttp, probeTcp, probeTarget, describeError } from '../src/probe.mjs';

let server;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('polaris-ok');
      return;
    }
    if (req.url === '/keyword') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello polaris world');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    }
    if (req.url === '/500') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow');
      }, 600);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function target(overrides) {
  return { type: 'http', timeoutMs: 2000, allowInsecure: false, keyword: '', expectStatus: null, ...overrides };
}

test('HTTP probe measures latency and status', async () => {
  const result = await probeHttp(target({ type: 'http', url: `http://127.0.0.1:${port}/ok` }), { timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.code, 200);
  assert.ok(result.latencyMs >= 0);
});

test('HTTP probe follows redirects', async () => {
  const result = await probeHttp(target({ type: 'http', url: `http://127.0.0.1:${port}/redirect` }), { timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.code, 200);
  assert.equal(result.meta.chain.length, 1);
});

test('HTTP probe enforces expected status codes', async () => {
  const result = await probeHttp(target({ type: 'http', url: `http://127.0.0.1:${port}/500` }), { timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /状态码 500/);

  const accepted = await probeHttp(target({
    type: 'http',
    url: `http://127.0.0.1:${port}/500`,
    expectStatus: [500],
  }), { timeoutMs: 2000 });
  assert.equal(accepted.ok, true);
});

test('HTTP probe checks keywords', async () => {
  const ok = await probeHttp(target({ type: 'http', url: `http://127.0.0.1:${port}/keyword`, keyword: 'polaris' }), { timeoutMs: 2000 });
  assert.equal(ok.ok, true);

  const missing = await probeHttp(target({ type: 'http', url: `http://127.0.0.1:${port}/keyword`, keyword: 'nope' }), { timeoutMs: 2000 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /关键字/);
});

test('HTTP probe reports connection failures and timeouts', async () => {
  const refused = await probeHttp(target({ type: 'http', url: 'http://127.0.0.1:1/', timeoutMs: 1000 }), { timeoutMs: 1000 });
  assert.equal(refused.ok, false);
  assert.ok(refused.error.length > 0);

  const slow = await probeHttp(target({ type: 'http', url: `http://127.0.0.1:${port}/slow`, timeoutMs: 150 }), { timeoutMs: 150 });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /超时/);
});

test('TCP probe connects and rejects closed ports', async () => {
  const open = await probeTcp({ host: '127.0.0.1', port, timeoutMs: 2000 }, { timeoutMs: 2000 });
  assert.equal(open.ok, true);
  assert.ok(open.latencyMs >= 0);

  const closedPort = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const freePort = probe.address().port;
      probe.close(() => resolve(freePort));
    });
  });
  const closed = await probeTcp({ host: '127.0.0.1', port: closedPort, timeoutMs: 500 }, { timeoutMs: 500 });
  assert.equal(closed.ok, false);
  assert.match(closed.error, /拒绝|超时/);
});

test('probeTarget routes by type and describeError localises codes', async () => {
  const result = await probeTarget({ type: 'tcp', host: '127.0.0.1', port, timeoutMs: 2000 }, { timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.match(describeError({ code: 'ECONNREFUSED' }), /拒绝/);
  assert.match(describeError({ code: 'POLARIS_TIMEOUT' }, 3000), /3000/);
  assert.equal(describeError(null), '探测失败');
});
