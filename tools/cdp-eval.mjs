#!/usr/bin/env node
// Evaluate JS in a page and print console output. Dev helper.
const args = process.argv.slice(2);
const get = (flag, fallback = '') => {
  const index = args.findIndex((arg) => arg === flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
};
const url = get('--url', 'http://127.0.0.1:8791/');
const expression = get('--eval', 'document.title');
const port = get('--port', '9222');
const wait = Number(get('--wait', '2500'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(`[console.${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description || ''}`);
  }
  if (message.method === 'Log.entryAdded') {
    logs.push(`[log.${message.params.entry.level}] ${message.params.entry.text}`);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url });
await sleep(wait);
const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
console.log('RESULT:', JSON.stringify(result.result?.value ?? result.result?.description ?? result, null, 2));
if (logs.length) console.log('LOGS:\n' + logs.join('\n'));
ws.close();
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
