#!/usr/bin/env node
// Screenshot helper that drives a headless Edge/Chrome already listening on CDP.
// Usage: node tools/screenshot.mjs --url http://127.0.0.1:8791/ --out .shots/home.png --width 1440 --height 1100 [--full] [--wait 3000] [--click 'selector']
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (flag, fallback = '') => {
  const index = args.findIndex((arg) => arg === flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
};
const has = (flag) => args.includes(flag);

const url = get('--url', 'http://127.0.0.1:8791/');
const out = get('--out', '.shots/shot.png');
const width = Number(get('--width', '1440'));
const height = Number(get('--height', '1000'));
const wait = Number(get('--wait', '2500'));
const click = get('--click', '');
const evaluate = get('--eval', '');
const full = has('--full');
const port = get('--port', '9222');
const mobile = has('--mobile');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newTarget() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`创建标签页失败: ${response.status}`);
  return response.json();
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      const handlers = this.events.get(message.method);
      if (handlers) handlers.forEach((fn) => fn(message.params));
    });
  }

  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    this.ws.close();
  }
}

const target = await newTarget();
const cdp = new CDP(target.webSocketDebuggerUrl);
await cdp.ready;
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(12000)]);
  await sleep(wait);

  if (click) {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(click)}); if (!el) return 'missing'; el.click(); return 'clicked'; })()`,
      returnByValue: true,
    });
    await sleep(1800);
  }

  if (evaluate) {
    await cdp.send('Runtime.evaluate', { expression: evaluate, awaitPromise: true, returnByValue: true });
    await sleep(600);
  }

  // Wait for cards if the app has rendered them.
  for (let i = 0; i < 20; i += 1) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.node-card').length`,
      returnByValue: true,
    });
    if (result.result.value > 0) break;
    await sleep(400);
  }

  const metrics = await cdp.send('Page.getLayoutMetrics');
  const content = metrics.cssContentSize || metrics.contentSize;
  const clipHeight = full ? Math.ceil(content.height) : height;
  const params = {
    format: 'png',
    captureBeyondViewport: full,
    fromSurface: true,
  };
  if (full) {
    params.clip = { x: 0, y: 0, width: Math.ceil(content.width), height: clipHeight, scale: 1 };
  }
  const shot = await cdp.send('Page.captureScreenshot', params);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(path.resolve(out), Buffer.from(shot.data, 'base64'));
  console.log(`${out} ${full ? `${Math.ceil(content.width)}x${clipHeight}` : `${width}x${height}`}`);
} finally {
  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
}
