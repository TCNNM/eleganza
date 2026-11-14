#!/usr/bin/env node
import path from 'node:path';
import { loadConfig, resolveConfigPath } from './src/config.mjs';
import { Store } from './src/store.mjs';
import { Prober } from './src/probe.mjs';
import { seedDemoData, DemoSource } from './src/demo.mjs';
import { Auth } from './src/auth.mjs';
import { McpServer } from './src/mcp.mjs';
import { Notifier } from './src/notify.mjs';
import { createPolarisServer, VERSION } from './src/app.mjs';

const argv = process.argv.slice(2);
const PROJECT_ROOT = path.resolve(import.meta.dirname);

function argValue(flag) {
  const index = argv.findIndex((arg) => arg === flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : '';
}

const configPath = resolveConfigPath(argv);
const demo = argv.includes('--demo') || process.env.POLARIS_DEMO === '1';
let config;
try {
  config = loadConfig(configPath, { demo });
} catch (error) {
  console.error(`\n[Polaris] 启动失败：${error.message}\n`);
  process.exit(1);
}

config.isDemo = demo || config.isDemo;
const port = Number(argValue('--port') || process.env.POLARIS_PORT || 8787);
const host = argValue('--host') || process.env.POLARIS_HOST || '127.0.0.1';

const store = new Store({ config });
const auth = new Auth({ config, dataDir: config.dataDir });
const mcp = new McpServer({ store, config });
const notifier = new Notifier({ config });
const server = createPolarisServer({
  config,
  store,
  auth,
  mcp,
  publicDir: path.join(PROJECT_ROOT, 'public'),
});

let prober = null;
let demoSource = null;

async function main() {
  await auth.init();
  if (config.isDemo) {
    seedDemoData(store, config);
    demoSource = new DemoSource({ store, config });
  } else {
    await store.load();
    if (notifier.enabled) {
      store.onEvent((event, incident, node) => notifier.send(event, incident, node));
    }
  }

  server.listen(port, host, () => {
    store.startPersistence();
    if (demoSource) demoSource.start();
    else {
      prober = new Prober({ store, config });
      prober.start();
    }
    const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    console.log(`\n  Polaris v${VERSION}`);
    console.log(`  config   ${config.file}`);
    console.log(`  mode     ${config.isDemo ? 'demo（演示数据）' : 'live（真实探测）'}`);
    console.log(`  nodes    ${store.targets.size} 个${config.site.public === false ? ' · 需要登录' : ''}`);
    console.log(`  notify   ${notifier.enabled ? '已启用（webhook / telegram）' : '未配置'}`);
    console.log(`  listen   http://${shown}:${port}\n`);
  });
}

async function shutdown(signal) {
  console.log(`\n[Polaris] 收到 ${signal}，正在停止…`);
  server.close();
  if (prober) await prober.stop();
  if (demoSource) demoSource.stop();
  await store.close();
  setTimeout(() => process.exit(0), 150).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('[Polaris] unhandledRejection:', error));

main().catch((error) => {
  console.error(`[Polaris] 启动失败：${error.message}`);
  process.exit(1);
});
