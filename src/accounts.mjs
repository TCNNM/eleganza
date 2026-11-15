import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { clamp, randomToken, safeEqual, sha256 } from './util.mjs';

const scryptAsync = promisify(crypto.scrypt);
const STORE_VERSION = 1;
const COOKIE_NAME = 'eleganza_session';
const MAX_USERS = 500;
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;

export const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'dark',
  accent: 'mint',
  density: 'comfortable',
  effects: true,
  motion: true,
});

export const PREFERENCE_OPTIONS = Object.freeze({
  theme: ['dark', 'light'],
  accent: ['mint', 'azure', 'violet', 'amber', 'rose', 'champagne'],
  density: ['comfortable', 'compact'],
  effects: [true, false],
  motion: [true, false],
});

export const SESSION_COOKIE = COOKIE_NAME;

export class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}

function cleanPreferences(input, { partial = false } = {}) {
  const out = partial ? {} : { ...DEFAULT_PREFERENCES };
  if (!input || typeof input !== 'object') {
    if (!partial) return out;
    return out;
  }
  for (const [key, allowed] of Object.entries(PREFERENCE_OPTIONS)) {
    if (!(key in input)) continue;
    let value = input[key];
    if (key === 'effects' || key === 'motion') value = value === true;
    if (!allowed.includes(value)) {
      throw new AccountError(`外观设置 ${key} 的取值不合法`);
    }
    out[key] = value;
  }
  return out;
}

function normalizeUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) {
    throw new AccountError('用户名需为 3–32 位，以字母或数字开头，只能包含字母、数字、点、下划线、短横线');
  }
  return value;
}

function normalizePassword(password) {
  const value = String(password ?? '');
  if (value.length < 8) throw new AccountError('密码至少需要 8 位');
  if (value.length > 200) throw new AccountError('密码过长');
  return value;
}

function normalizeDisplayName(displayName, fallback) {
  const value = String(displayName || '').trim() || fallback;
  if (value.length > 40) throw new AccountError('显示名称不能超过 40 个字符');
  return value;
}

export class Accounts {
  constructor({ config, dataDir, log = console, seedDemo = true }) {
    this.config = config;
    this.dataDir = dataDir;
    this.log = log;
    this.file = path.join(dataDir, 'accounts.json');
    this.users = [];
    this.sessions = [];
    this.dirty = false;
    this.saveTimer = null;
    this.saving = null;
    this.dummyHash = null;
    const options = config.accounts || {};
    this.required = options.required === true || config.site?.public === false;
    this.allowRegistration = options.allowRegistration === true;
    this.sessionHours = clamp(Number(options.sessionHours) || 168, 1, 24 * 365);
    this.setupToken = options.setupToken ? String(options.setupToken) : '';
    this.generatedSetupToken = '';
    this.demoAccounts = [];
    this.demo = config.isDemo === true && seedDemo === true;
  }

  get cookieName() {
    return COOKIE_NAME;
  }

  get setupRequired() {
    return this.users.length === 0;
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await this.load();
    this.pruneSessions();
    if (this.demo) await this.ensureDemoAccounts();
    if (this.users.length === 0) {
      if (!this.setupToken) {
        this.generatedSetupToken = crypto.randomBytes(9).toString('hex');
        this.setupToken = this.generatedSetupToken;
      }
    }
    this.startSaveTimer();
    return this;
  }

  async load() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') this.log.warn?.(`账号文件读取失败，忽略: ${error.message}`);
      return;
    }
    if (!raw || raw.version !== STORE_VERSION) return;
    this.users = (Array.isArray(raw.users) ? raw.users : []).map((user) => ({
      id: String(user.id || ''),
      username: String(user.username || ''),
      usernameLower: String(user.usernameLower || user.username || '').toLowerCase(),
      displayName: String(user.displayName || user.username || ''),
      role: user.role === 'admin' ? 'admin' : 'member',
      passwordHash: String(user.passwordHash || ''),
      preferences: { ...DEFAULT_PREFERENCES, ...(user.preferences || {}) },
      createdAt: Number(user.createdAt) || Date.now(),
      updatedAt: Number(user.updatedAt) || Date.now(),
      lastLoginAt: user.lastLoginAt ? Number(user.lastLoginAt) : null,
      disabled: user.disabled === true,
    })).filter((user) => user.id && user.usernameLower && user.passwordHash);
    this.sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
      .map((session) => ({
        tokenHash: String(session.tokenHash || ''),
        userId: String(session.userId || ''),
        createdAt: Number(session.createdAt) || 0,
        expiresAt: Number(session.expiresAt) || 0,
        ip: String(session.ip || '').slice(0, 80),
        userAgent: String(session.userAgent || '').slice(0, 200),
      }))
      .filter((session) => session.tokenHash && session.userId && session.expiresAt);
  }

  startSaveTimer() {
    if (this.saveTimer) return;
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.save().catch((error) => this.log.warn?.(`账号保存失败: ${error.message}`));
    }, 15_000);
    this.saveTimer.unref?.();
  }

  markDirty() {
    this.dirty = true;
  }

  async saveNow() {
    if (this.saving) await this.saving;
    const payload = {
      version: STORE_VERSION,
      savedAt: Date.now(),
      users: this.users,
      sessions: this.sessions,
    };
    await mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    this.dirty = false;
  }

  async save() {
    if (this.saving) return this.saving;
    this.saving = this.saveNow()
      .catch((error) => this.log.warn?.(`账号保存失败: ${error.message}`))
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }

  async close() {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  async ensureDemoAccounts() {
    if (this.users.length > 0) {
      this.demoAccounts = [
        { username: 'admin', password: 'eleganza', role: 'admin' },
        { username: 'visitor', password: 'visitor123', role: 'member' },
      ].filter((account) => this.findByUsername(account.username));
      return;
    }
    await this.createUser({ username: 'admin', password: 'eleganza', displayName: 'Eleganza Admin', role: 'admin' });
    await this.createUser({ username: 'visitor', password: 'visitor123', displayName: '访客', role: 'member' });
    this.demoAccounts = [
      { username: 'admin', password: 'eleganza', role: 'admin' },
      { username: 'visitor', password: 'visitor123', role: 'member' },
    ];
    await this.saveNow();
  }

  // ---------------------------------------------------------------- passwords

  async hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    try {
      const salt = Buffer.from(saltB64, 'base64url');
      const expected = Buffer.from(hashB64, 'base64url');
      const key = await scryptAsync(String(password), salt, expected.length, {
        N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
      });
      return key.length === expected.length && crypto.timingSafeEqual(key, expected);
    } catch {
      return false;
    }
  }

  async dummyVerify(password) {
    if (!this.dummyHash) this.dummyHash = await this.hashPassword('eleganza-dummy-password');
    await this.verifyPassword(password, this.dummyHash);
    return false;
  }

  // ------------------------------------------------------------------- users

  findById(id) {
    return this.users.find((user) => user.id === id) || null;
  }

  findByUsername(username) {
    const needle = String(username || '').trim().toLowerCase();
    if (!needle) return null;
    return this.users.find((user) => user.usernameLower === needle) || null;
  }

  activeAdmins() {
    return this.users.filter((user) => user.role === 'admin' && !user.disabled);
  }

  publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      preferences: user.preferences || { ...DEFAULT_PREFERENCES },
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      disabled: user.disabled === true,
    };
  }

  async createUser({ username, password, displayName, role = 'member' }) {
    if (this.users.length >= MAX_USERS) throw new AccountError('账号数量已达上限', 409);
    const cleanUsername = normalizeUsername(username);
    const cleanPassword = normalizePassword(password);
    const cleanRole = role === 'admin' ? 'admin' : 'member';
    if (this.findByUsername(cleanUsername)) throw new AccountError('该用户名已被使用', 409);
    const passwordHash = await this.hashPassword(cleanPassword);
    const now = Date.now();
    const user = {
      id: `u_${randomToken(9)}`,
      username: cleanUsername,
      usernameLower: cleanUsername.toLowerCase(),
      displayName: normalizeDisplayName(displayName, cleanUsername),
      role: cleanRole,
      passwordHash,
      preferences: { ...DEFAULT_PREFERENCES },
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      disabled: false,
    };
    this.users.push(user);
    this.markDirty();
    return user;
  }

  async setup({ username, password, displayName, token }, context = {}) {
    if (!this.setupRequired) throw new AccountError('管理员已初始化', 409);
    if (!safeEqual(String(token || ''), this.setupToken)) {
      throw new AccountError('初始化令牌不正确', 403);
    }
    const user = await this.createUser({ username, password, displayName, role: 'admin' });
    this.setupToken = '';
    this.generatedSetupToken = '';
    const session = this.createSession(user, context);
    await this.saveNow();
    return { user: this.publicUser(user), ...session };
  }

  async forcePasswordReset(username, password) {
    const user = this.findByUsername(username);
    if (!user) throw new AccountError(`账号不存在: ${username}`, 404);
    user.passwordHash = await this.hashPassword(normalizePassword(password));
    user.updatedAt = Date.now();
    this.revokeUserSessions(user.id);
    await this.saveNow();
    return this.publicUser(user);
  }

  async register({ username, password, displayName }, context = {}) {
    if (!this.allowRegistration) throw new AccountError('当前未开放注册', 403);
    const user = await this.createUser({ username, password, displayName, role: 'member' });
    const session = this.createSession(user, context);
    await this.save();
    return { user: this.publicUser(user), ...session };
  }

  async login(username, password, context = {}) {
    const user = this.findByUsername(username);
    if (!user || user.disabled) {
      await this.dummyVerify(password);
      throw new AccountError('用户名或密码不正确', 401);
    }
    const ok = await this.verifyPassword(password, user.passwordHash);
    if (!ok) throw new AccountError('用户名或密码不正确', 401);
    user.lastLoginAt = Date.now();
    user.updatedAt = user.lastLoginAt;
    const session = this.createSession(user, context);
    this.markDirty();
    return { user: this.publicUser(user), ...session };
  }

  updateOwnProfile(userId, { displayName, preferences }) {
    const user = this.findById(userId);
    if (!user) throw new AccountError('账号不存在', 404);
    if (displayName !== undefined) user.displayName = normalizeDisplayName(displayName, user.username);
    if (preferences !== undefined) user.preferences = { ...user.preferences, ...cleanPreferences(preferences, { partial: true }) };
    user.updatedAt = Date.now();
    this.markDirty();
    return this.publicUser(user);
  }

  async changeOwnPassword(userId, currentPassword, newPassword) {
    const user = this.findById(userId);
    if (!user) throw new AccountError('账号不存在', 404);
    const ok = await this.verifyPassword(String(currentPassword || ''), user.passwordHash);
    if (!ok) throw new AccountError('当前密码不正确', 403);
    user.passwordHash = await this.hashPassword(normalizePassword(newPassword));
    user.updatedAt = Date.now();
    this.revokeUserSessions(user.id);
    this.markDirty();
    return this.publicUser(user);
  }

  // ------------------------------------------------------------------- admin

  listUsers() {
    return this.users
      .map((user) => ({ ...this.publicUser(user), lastLoginAt: user.lastLoginAt }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  assertAdmin(actor) {
    const user = this.findById(actor?.id || actor);
    if (!user || user.role !== 'admin' || user.disabled) throw new AccountError('需要管理员权限', 403);
    return user;
  }

  async adminCreateUser(actor, payload) {
    this.assertAdmin(actor);
    const user = await this.createUser(payload);
    await this.save();
    return this.publicUser(user);
  }

  async adminUpdateUser(actorId, targetId, patch = {}) {
    const actor = this.assertAdmin(actorId);
    const target = this.findById(targetId);
    if (!target) throw new AccountError('账号不存在', 404);
    if (target.id === actor.id && (patch.disabled === true || patch.role === 'member')) {
      throw new AccountError('不能禁用或降级自己的管理员账号', 409);
    }
    if (target.role === 'admin' && !target.disabled && (patch.role === 'member' || patch.disabled === true)) {
      if (this.activeAdmins().length <= 1) throw new AccountError('必须至少保留一个可用的管理员', 409);
    }
    if (patch.displayName !== undefined) target.displayName = normalizeDisplayName(patch.displayName, target.username);
    if (patch.role !== undefined) {
      if (!['admin', 'member'].includes(patch.role)) throw new AccountError('角色不合法');
      target.role = patch.role;
    }
    if (patch.disabled !== undefined) target.disabled = patch.disabled === true;
    if (patch.preferences !== undefined) target.preferences = { ...target.preferences, ...cleanPreferences(patch.preferences, { partial: true }) };
    let passwordChanged = false;
    if (patch.password !== undefined && patch.password !== '') {
      target.passwordHash = await this.hashPassword(normalizePassword(patch.password));
      passwordChanged = true;
    }
    target.updatedAt = Date.now();
    if (target.disabled || passwordChanged) this.revokeUserSessions(target.id);
    await this.save();
    return this.publicUser(target);
  }

  async adminDeleteUser(actorId, targetId) {
    const actor = this.assertAdmin(actorId);
    if (actor.id === targetId) throw new AccountError('不能删除自己的账号', 409);
    const target = this.findById(targetId);
    if (!target) throw new AccountError('账号不存在', 404);
    if (target.role === 'admin' && !target.disabled && this.activeAdmins().length <= 1) {
      throw new AccountError('必须至少保留一个可用的管理员', 409);
    }
    this.users = this.users.filter((user) => user.id !== targetId);
    this.revokeUserSessions(targetId);
    await this.save();
    return true;
  }

  // ---------------------------------------------------------------- sessions

  createSession(user, context = {}) {
    const now = Date.now();
    const token = randomToken(32);
    const session = {
      tokenHash: sha256(token),
      userId: user.id,
      createdAt: now,
      expiresAt: now + this.sessionHours * 3600 * 1000,
      ip: String(context.ip || '').slice(0, 80),
      userAgent: String(context.userAgent || '').slice(0, 200),
    };
    this.sessions.push(session);
    this.pruneSessions(now);
    this.markDirty();
    return { token, expiresAt: session.expiresAt };
  }

  resolveSession(token, now = Date.now()) {
    if (!token) return null;
    const tokenHash = sha256(String(token));
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.sessions = this.sessions.filter((item) => item !== session);
      this.markDirty();
      return null;
    }
    const user = this.findById(session.userId);
    if (!user || user.disabled) return null;
    return { user: this.publicUser(user), session };
  }

  revokeSession(token) {
    if (!token) return false;
    const tokenHash = sha256(String(token));
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((session) => session.tokenHash !== tokenHash);
    const changed = this.sessions.length !== before;
    if (changed) this.markDirty();
    return changed;
  }

  revokeUserSessions(userId) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((session) => session.userId !== userId);
    if (this.sessions.length !== before) this.markDirty();
  }

  pruneSessions(now = Date.now()) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((session) => session.expiresAt > now);
    if (this.sessions.length !== before) this.markDirty();
  }

  get demoCredentials() {
    return this.demo ? this.demoAccounts : [];
  }
}
