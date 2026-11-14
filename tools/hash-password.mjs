#!/usr/bin/env node
// Generate a SHA-256 password hash for config.auth.passwordSha256
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const password = process.argv[2] || process.env.POLARIS_PASSWORD;

async function readPassword() {
  if (password) return password;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('设置面板密码: ');
  rl.close();
  return answer;
}

const value = await readPassword();
if (!value) {
  console.error('用法: node tools/hash-password.mjs <密码>');
  process.exit(1);
}
const hash = createHash('sha256').update(value).digest('hex');
console.log(`\n把下面两项写进 config.json：\n`);
console.log(`  "site": { "public": false }`);
console.log(`  "auth": { "passwordSha256": "${hash}" }\n`);
console.log(`提示：生成的会话密钥是随机的，建议同时设置 auth.mcpToken 供 MCP 客户端使用。`);
