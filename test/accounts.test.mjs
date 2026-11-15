import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Accounts, AccountError } from '../src/accounts.mjs';

const quiet = { info() {}, warn() {}, error() {} };

async function makeAccounts(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eleganza-accounts-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({
    dataDir: 'data',
    site: { title: 'Accounts Test' },
    accounts: { required: false, allowRegistration: false, sessionHours: 168, setupToken: 'setup-token' },
    targets: [],
    ...options,
  }));
  const config = loadConfig(file);
  const accounts = new Accounts({ config, dataDir: config.dataDir, log: quiet, seedDemo: false });
  await accounts.init();
  return { accounts, config };
}

test('setup creates the first admin and consumes the setup token', async () => {
  const { accounts } = await makeAccounts();
  assert.equal(accounts.setupRequired, true);
  await assert.rejects(accounts.setup({ username: 'admin', password: 'password123', token: 'wrong' }), AccountError);
  const result = await accounts.setup({ username: 'admin', password: 'password123', displayName: 'Admin', token: 'setup-token' }, { ip: '127.0.0.1' });
  assert.equal(result.user.role, 'admin');
  assert.equal(accounts.setupRequired, false);
  assert.equal(result.user.preferences.style, 'cosmos');
  const session = accounts.resolveSession(result.token);
  assert.equal(session.user.username, 'admin');
  await assert.rejects(accounts.setup({ username: 'other', password: 'password123', token: 'setup-token' }), /已初始化/);
  await accounts.close();
});

test('login, session expiry and logout', async () => {
  const { accounts } = await makeAccounts();
  await accounts.createUser({ username: 'alice', password: 'alice-password', displayName: 'Alice', role: 'member' });
  await assert.rejects(accounts.login('alice', 'wrong-password'), /不正确/);
  const result = await accounts.login('alice', 'alice-password', { ip: '10.0.0.1' });
  assert.equal(result.user.username, 'alice');
  assert.ok(accounts.resolveSession(result.token));
  assert.equal(accounts.resolveSession('nope'), null);

  accounts.sessions[0].expiresAt = Date.now() - 1000;
  assert.equal(accounts.resolveSession(result.token), null);

  const second = await accounts.login('alice', 'alice-password');
  assert.equal(accounts.revokeSession(second.token), true);
  assert.equal(accounts.resolveSession(second.token), null);
  await accounts.close();
});

test('preferences and display names are validated', async () => {
  const { accounts } = await makeAccounts();
  const user = await accounts.createUser({ username: 'alice', password: 'alice-password', displayName: 'Alice' });
  const updated = accounts.updateOwnProfile(user.id, {
    displayName: '艾丽丝',
    preferences: { style: 'paper', accent: 'champagne', density: 'compact', effects: false, motion: false },
  });
  assert.equal(updated.displayName, '艾丽丝');
  assert.equal(updated.preferences.accent, 'champagne');
  assert.equal(updated.preferences.effects, false);
  const bandTheme = accounts.updateOwnProfile(user.id, {
    preferences: { style: 'roselia', accent: 'roselia-violet' },
  });
  assert.equal(bandTheme.preferences.style, 'roselia');
  assert.equal(bandTheme.preferences.accent, 'roselia-violet');
  assert.throws(() => accounts.updateOwnProfile(user.id, { preferences: { accent: 'rainbow' } }), AccountError);
  assert.throws(() => accounts.updateOwnProfile(user.id, { displayName: 'x'.repeat(41) }), AccountError);
  await accounts.close();
});

test('password changes revoke sessions and new password works', async () => {
  const { accounts } = await makeAccounts();
  const user = await accounts.createUser({ username: 'alice', password: 'alice-password' });
  const login = await accounts.login('alice', 'alice-password');
  await assert.rejects(accounts.changeOwnPassword(user.id, 'wrong', 'new-password-123'), /当前密码/);
  await accounts.changeOwnPassword(user.id, 'alice-password', 'new-password-123');
  assert.equal(accounts.resolveSession(login.token), null);
  await assert.rejects(accounts.login('alice', 'alice-password'), /不正确/);
  const relogin = await accounts.login('alice', 'new-password-123');
  assert.ok(relogin.token);
  await accounts.close();
});

test('admin rules protect the last administrator and self-deletion', async () => {
  const { accounts } = await makeAccounts();
  const admin = await accounts.createUser({ username: 'admin', password: 'admin-password', role: 'admin' });
  await assert.rejects(accounts.adminDeleteUser(admin.id, admin.id), /自己/);
  await assert.rejects(accounts.adminUpdateUser(admin.id, admin.id, { role: 'member' }), /自己/);

  const second = await accounts.createUser({ username: 'second', password: 'second-password', role: 'admin' });
  const demoted = await accounts.adminUpdateUser(admin.id, second.id, { role: 'member' });
  assert.equal(demoted.role, 'member');
  await assert.rejects(accounts.adminDeleteUser(admin.id, admin.id), /自己/);
  await assert.rejects(accounts.adminUpdateUser(admin.id, admin.id, { disabled: true }), /自己/);

  const member = await accounts.createUser({ username: 'member', password: 'member-password' });
  await assert.rejects(accounts.adminUpdateUser(member.id, admin.id, { role: 'member' }), /管理员/);
  await accounts.close();
});

test('accounts and sessions persist across restarts', async () => {
  const { accounts, config } = await makeAccounts();
  const admin = await accounts.createUser({ username: 'admin', password: 'admin-password', role: 'admin' });
  accounts.updateOwnProfile(admin.id, { preferences: { style: 'gilded', accent: 'azure' } });
  const session = accounts.createSession(admin);
  await accounts.close();

  const restored = new Accounts({ config, dataDir: config.dataDir, log: quiet, seedDemo: false });
  await restored.init();
  assert.equal(restored.users.length, 1);
  assert.equal(restored.users[0].preferences.accent, 'azure');
  assert.ok(restored.resolveSession(session.token));
  const login = await restored.login('admin', 'admin-password');
  assert.equal(login.user.role, 'admin');
  await restored.close();
});

test('demo mode seeds admin and visitor accounts', async () => {
  const { accounts: empty, config } = await makeAccounts({ demo: true });
  await empty.close();
  const demo = new Accounts({ config, dataDir: config.dataDir, log: quiet, seedDemo: true });
  await demo.init();
  assert.equal(demo.users.length, 2);
  assert.equal(demo.demoCredentials.length, 2);
  const login = await demo.login('admin', 'eleganza');
  assert.equal(login.user.role, 'admin');
  const visitor = await demo.login('visitor', 'visitor123');
  assert.equal(visitor.user.role, 'member');
  await demo.close();
});
