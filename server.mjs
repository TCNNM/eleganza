#!/usr/bin/env node
import path from 'node:path';
import { loadConfig, resolveConfigPath } from './src/config.mjs';
import { Store } from './src/store.mjs';
import { Prober } from './src/probe.mjs';
import { seedDemoData, DemoSource } from './src/demo.mjs';
import { Accounts } from './src/accounts.mjs';
import { Notifier } from './src/notify.mjs';
import { createEleganzaServer, VERSION } from './src/app.mjs';

const argv = process.argv.slice(2);
const PROJECT_ROOT = path.resolve(import.meta.dirname);

function argValue(flag) {
  const index = argv.findIndex((arg) => arg === flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : '';
}

const configPath = resolveConfigPath(argv);
const demo = argv.includes('--demo') || process.env.ELEGANZA_DEMO === '1';
let config;
try {
  config = loadConfig(configPath, { demo });
} catch (error) {
  console.error(`\n[Eleganza] 启动失败：${error.message}\n`);
  process.exit(1);
}

config.isDemo = demo || config.isDemo;
const port = Number(argValue('--port') || process.env.ELEGANZA_PORT || 8787);
const host = argValue('--host') || process.env.ELEGANZA_HOST || '127.0.0.1';

const store = new Store({ config });
const accounts = new Accounts({ config, dataDir: config.dataDir });
const notifier = new Notifier({ config });
const server = createEleganzaServer({
  config,
  store,
  accounts,
  publicDir: path.join(PROJECT_ROOT, 'public'),
});

let prober = null;
let demoSource = null;

async function main() {
  await accounts.init();
  if (config.legacyPasswordAuth) {
    console.warn('  [提示] 旧版 auth.passwordSha256 已停用，请使用账号系统或 tools/create-admin.mjs 创建管理员。');
  }
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
    console.log(`\n  Eleganza v${VERSION}`);
    console.log(`  config   ${config.file}`);
    console.log(`  mode     ${config.isDemo ? 'demo（演示数据）' : 'live（真实探测）'}`);
    console.log(`  nodes    ${store.targets.size} 个`);
    console.log(`  accounts ${accounts.users.length} 个${accounts.required ? ' · 必须登录' : ' · 可选登录'}`);
    console.log(`  notify   ${notifier.enabled ? '已启用（webhook / telegram）' : '未配置'}`);
    console.log(`  listen   http://${shown}:${port}`);
    if (accounts.demo && accounts.demoCredentials.length) {
      console.log('\n  演示账号（仅 demo 模式）:');
      for (const account of accounts.demoCredentials) {
        console.log(`    ${account.role.padEnd(6)} ${account.username} / ${account.password}`);
      }
    } else if (accounts.setupRequired) {
      console.log('\n  尚未创建管理员。打开面板按提示初始化，或运行：');
      console.log(`    node tools/create-admin.mjs admin --config ${config.file}`);
      if (accounts.generatedSetupToken) {
        console.log(`  初始化令牌: ${accounts.generatedSetupToken}`);
      } else if (config.accounts?.setupToken) {
        console.log('  初始化令牌已配置在 config.accounts.setupToken');
      }
    }
    console.log('');
  });
}

async function shutdown(signal) {
  console.log(`\n[Eleganza] 收到 ${signal}，正在停止…`);
  server.close();
  if (prober) await prober.stop();
  if (demoSource) demoSource.stop();
  await store.close();
  await accounts.close();
  setTimeout(() => process.exit(0), 150).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('[Eleganza] unhandledRejection:', error));

main().catch((error) => {
  console.error(`[Eleganza] 启动失败：${error.message}`);
  process.exit(1);
});
