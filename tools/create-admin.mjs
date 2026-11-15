#!/usr/bin/env node
// Create an admin (or reset a password) without opening the panel.
//
//   node tools/create-admin.mjs admin
//   node tools/create-admin.mjs admin --password 'a-long-random-password'
//   node tools/create-admin.mjs existing-user --reset
//   node tools/create-admin.mjs ops --role member --config /etc/eleganza/config.json
import { createInterface } from 'node:readline/promises';
import { Accounts } from '../src/accounts.mjs';
import { loadConfig, resolveConfigPath } from '../src/config.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const username = positional[0];

if (!username || argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法: node tools/create-admin.mjs <用户名> [选项]

选项:
  --password <密码>      不交互输入（至少 8 位）
  --display-name <名称>  显示名称
  --role <admin|member>  角色，默认 admin
  --reset                重置已存在账号的密码
  --config <文件>        指定配置文件
`);
  process.exit(username ? 0 : 2);
}

function argValue(flag) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : '';
}

async function askPassword() {
  let password = argValue('--password');
  if (password) return password;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('设置密码（至少 8 位）: ');
  } finally {
    rl.close();
  }
}

const file = resolveConfigPath(argv);
let config;
try {
  config = loadConfig(file, { demo: false });
} catch (error) {
  console.error(`配置加载失败: ${error.message}`);
  process.exit(1);
}
const accounts = new Accounts({ config, dataDir: config.dataDir, seedDemo: false });
await accounts.init();
const password = await askPassword();
if (password.length < 8) {
  console.error('密码至少需要 8 位');
  await accounts.close();
  process.exit(1);
}
const reset = argv.includes('--reset');
const role = argValue('--role') === 'member' ? 'member' : 'admin';
const displayName = argValue('--display-name') || username;

try {
  if (reset) {
    const user = await accounts.forcePasswordReset(username, password);
    console.log(`已重置 ${user.username} 的密码。`);
  } else {
    const user = await accounts.createUser({ username, password, displayName, role });
    await accounts.saveNow();
    console.log(`已创建${user.role === 'admin' ? '管理员' : '成员'}账号: ${user.username}`);
  }
  console.log(`配置文件: ${config.file}`);
  console.log(`账号文件: ${config.dataDir}/accounts.json`);
} catch (error) {
  console.error(`失败: ${error.message}`);
  process.exitCode = 1;
} finally {
  await accounts.close();
}
