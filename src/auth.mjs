import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hmac, randomToken, safeEqual, sha256 } from './util.mjs';

const COOKIE_NAME = 'polaris_session';
const SECRET_FILE = 'session-secret';

export class Auth {
  constructor({ config, dataDir, log = console }) {
    this.config = config;
    this.site = config.site;
    this.log = log;
    this.required = this.site.public === false;
    this.dataDir = dataDir;
    this.secret = '';
    this.passwordSha256 = config.auth?.passwordSha256 || '';
    this.mcpToken = config.auth?.mcpToken || '';
  }

  async init() {
    if (!this.required) return;
    if (!this.passwordSha256) {
      throw new Error('site.public 为 false，但没有配置 auth.passwordSha256。运行 npm run hash-password 生成后写入配置。');
    }
    await mkdir(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, SECRET_FILE);
    try {
      this.secret = (await readFile(file, 'utf8')).trim();
    } catch {
      this.secret = randomToken(32);
      await writeFile(file, `${this.secret}\n`, { mode: 0o600 });
    }
  }

  verifyPassword(password) {
    if (!this.passwordSha256) return false;
    return safeEqual(sha256(password), this.passwordSha256);
  }

  createSession(now = Date.now()) {
    const exp = now + this.config.auth.sessionHours * 3600 * 1000;
    const signature = hmac(this.secret, String(exp));
    return { value: `${exp}.${signature}`, expiresAt: exp };
  }

  verifySession(value, now = Date.now()) {
    if (!value || !this.secret) return false;
    const [rawExp, signature] = value.split('.');
    const exp = Number(rawExp);
    if (!Number.isFinite(exp) || exp < now || !signature) return false;
    return safeEqual(signature, hmac(this.secret, String(exp)));
  }

  readSession(cookies) {
    return this.verifySession(cookies?.[COOKIE_NAME]);
  }

  cookieHeader({ secure = false } = {}) {
    const session = this.createSession();
    const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000);
    return `${COOKIE_NAME}=${session.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  clearCookieHeader({ secure = false } = {}) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  authorizeBearer(header) {
    if (!this.mcpToken) return false;
    const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
    return Boolean(match && safeEqual(match[1].trim(), this.mcpToken));
  }

  sessionCookieName() {
    return COOKIE_NAME;
  }
}
