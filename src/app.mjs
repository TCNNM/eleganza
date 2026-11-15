import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseCookies, readJsonBody, safeEqual } from './util.mjs';
import { AccountError, SESSION_COOKIE } from './accounts.mjs';

export const VERSION = '1.2.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createEleganzaServer({ config, store, accounts, publicDir, version = VERSION, log = console }) {
  const staticDir = path.resolve(publicDir);
  const loginAttempts = new Map();
  const agentAttempts = new Map();

  function rateLimit(map, key, limit, windowMs) {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now > entry.reset) {
      map.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  function isSecure(req) {
    if (req.socket.encrypted) return true;
    if (config.site.trustProxy !== true) return false;
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function securityHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  function send(res, status, body, headers = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { 'Content-Length': buffer.length, ...headers });
    if (res.req?.method === 'HEAD') res.end();
    else res.end(buffer);
  }

  function sendJson(req, res, status, data, headers = {}) {
    let body = Buffer.from(JSON.stringify(data));
    const extra = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      body = gzipSync(body);
      extra['Content-Encoding'] = 'gzip';
      extra.Vary = 'Accept-Encoding';
    }
    send(res, status, body, { ...extra, ...headers });
  }

  function clientIp(req) {
    const forwarded = config.site.trustProxy === true
      ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  }

  function parseUrl(req) {
    return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  }

  function cookieToken(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  }

  function currentSession(req) {
    const token = cookieToken(req);
    if (!token) return null;
    const resolved = accounts.resolveSession(token);
    return resolved ? { ...resolved, token } : null;
  }

  function currentUser(req) {
    return currentSession(req)?.user || null;
  }

  function sessionCookie(token, expiresAt, req) {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
  }

  function clearCookie(req) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`;
  }

  function readAllowed(req) {
    return !accounts.required || Boolean(currentUser(req));
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === String(req.headers.host || '');
    } catch {
      return false;
    }
  }

  async function readBody(req, res, limit) {
    try {
      return await readJsonBody(req, { limit });
    } catch (error) {
      sendJson(req, res, error.statusCode || 400, { error: error.message });
      return null;
    }
  }

  function fail(req, res, error) {
    if (error instanceof AccountError) {
      return sendJson(req, res, error.status, { error: error.message });
    }
    log.error?.('[Eleganza] 账号操作失败:', error);
    return sendJson(req, res, 500, { error: '服务器内部错误' });
  }

  function authContext(req) {
    return {
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    };
  }

  async function handleAuthStatus(req, res) {
    const session = currentSession(req);
    return sendJson(req, res, 200, {
      required: accounts.required,
      setupRequired: accounts.setupRequired,
      allowRegistration: accounts.allowRegistration,
      sessionHours: accounts.sessionHours,
      demo: config.isDemo === true,
      demoAccounts: accounts.demoCredentials,
      user: session?.user || null,
      site: { title: config.site.title, subtitle: config.site.subtitle },
    });
  }

  async function handleSetup(req, res) {
    if (!rateLimit(loginAttempts, `setup|${clientIp(req)}`, 8, 5 * 60 * 1000)) {
      return sendJson(req, res, 429, { error: '尝试次数过多，请稍后再试' });
    }
    const body = await readBody(req, res, 8 * 1024);
    if (!body) return;
    try {
      const result = await accounts.setup({
        username: body.username,
        password: body.password,
        displayName: body.displayName,
        token: body.token,
      }, authContext(req));
      res.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt, req));
      return sendJson(req, res, 200, {
        user: result.user,
        expiresAt: result.expiresAt,
        setupRequired: false,
        required: accounts.required,
      });
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return fail(req, res, error);
    }
  }

  async function handleLogin(req, res) {
    const body = await readBody(req, res, 8 * 1024);
    if (!body) return;
    const username = String(body.username || '').trim();
    const ip = clientIp(req);
    if (!rateLimit(loginAttempts, `${ip}|${username.toLowerCase()}`, 10, 5 * 60 * 1000)) {
      return sendJson(req, res, 429, { error: '尝试次数过多，请稍后再试' });
    }
    try {
      const result = await accounts.login(username, String(body.password || ''), authContext(req));
      res.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt, req));
      return sendJson(req, res, 200, {
        user: result.user,
        expiresAt: result.expiresAt,
        required: accounts.required,
        setupRequired: accounts.setupRequired,
      });
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return fail(req, res, error);
    }
  }

  async function handleRegister(req, res) {
    if (!accounts.allowRegistration) {
      return sendJson(req, res, 403, { error: '当前未开放注册' });
    }
    if (!rateLimit(loginAttempts, `register|${clientIp(req)}`, 5, 10 * 60 * 1000)) {
      return sendJson(req, res, 429, { error: '尝试次数过多，请稍后再试' });
    }
    const body = await readBody(req, res, 8 * 1024);
    if (!body) return;
    try {
      const result = await accounts.register({
        username: body.username,
        password: body.password,
        displayName: body.displayName,
      }, authContext(req));
      res.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt, req));
      return sendJson(req, res, 200, { user: result.user, expiresAt: result.expiresAt });
    } catch (error) {
      return fail(req, res, error);
    }
  }

  async function handleLogout(req, res) {
    const token = cookieToken(req);
    if (token) {
      accounts.revokeSession(token);
      await accounts.save();
    }
    res.setHeader('Set-Cookie', clearCookie(req));
    return sendJson(req, res, 200, { ok: true });
  }

  async function handleAccount(req, res, user) {
    if (req.method === 'GET') {
      return sendJson(req, res, 200, { user });
    }
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'GET, PATCH');
      return sendJson(req, res, 405, { error: 'Method Not Allowed' });
    }
    const body = await readBody(req, res, 16 * 1024);
    if (!body) return;
    try {
      if (body.newPassword) {
        await accounts.changeOwnPassword(user.id, body.currentPassword, body.newPassword);
        const session = accounts.createSession(accounts.findById(user.id), authContext(req));
        await accounts.save();
        res.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt, req));
        return sendJson(req, res, 200, {
          user: accounts.publicUser(accounts.findById(user.id)),
          passwordChanged: true,
        });
      }
      const updated = accounts.updateOwnProfile(user.id, {
        displayName: body.displayName,
        preferences: body.preferences,
      });
      await accounts.save();
      return sendJson(req, res, 200, { user: updated });
    } catch (error) {
      return fail(req, res, error);
    }
  }

  async function handleAdminUsers(req, res, user, pathname, method) {
    if (user.role !== 'admin') return sendJson(req, res, 403, { error: '需要管理员权限' });
    if (pathname === '/api/admin/users') {
      if (method === 'GET') {
        return sendJson(req, res, 200, { users: accounts.listUsers() });
      }
      if (method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }
      const body = await readBody(req, res, 8 * 1024);
      if (!body) return;
      try {
        const created = await accounts.adminCreateUser(user.id, {
          username: body.username,
          password: body.password,
          displayName: body.displayName,
          role: body.role,
        });
        return sendJson(req, res, 201, { user: created });
      } catch (error) {
        return fail(req, res, error);
      }
    }
    const match = /^\/api\/admin\/users\/([a-zA-Z0-9._-]+)$/.exec(pathname);
    if (!match) return sendJson(req, res, 404, { error: '接口不存在' });
    const targetId = match[1];
    if (method === 'PATCH') {
      const body = await readBody(req, res, 16 * 1024);
      if (!body) return;
      try {
        const updated = await accounts.adminUpdateUser(user.id, targetId, body);
        return sendJson(req, res, 200, { user: updated });
      } catch (error) {
        return fail(req, res, error);
      }
    }
    if (method === 'DELETE') {
      try {
        await accounts.adminDeleteUser(user.id, targetId);
        return sendJson(req, res, 200, { ok: true });
      } catch (error) {
        return fail(req, res, error);
      }
    }
    res.setHeader('Allow', 'PATCH, DELETE');
    return sendJson(req, res, 405, { error: 'Method Not Allowed' });
  }

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (rel === 'favicon.ico') rel = 'favicon.svg';
    if (rel.includes('\0')) return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
    const file = path.resolve(staticDir, rel);
    if (file !== path.join(staticDir, 'index.html') && !file.startsWith(`${staticDir}${path.sep}`)) {
      return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
    }
    let info;
    try {
      info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const isHtml = file.endsWith('.html');
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    let body = await readFile(file);
    if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && !file.endsWith('.png') && !file.endsWith('.woff2')) {
      body = gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  async function handleAgentReport(req, res) {
    const ip = clientIp(req);
    if (!rateLimit(agentAttempts, ip, 240, 60 * 1000)) {
      return sendJson(req, res, 429, { error: '上报过于频繁' });
    }
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!match) return sendJson(req, res, 401, { error: '缺少 Agent Token' });
    const token = match[1].trim();
    let target = null;
    for (const state of store.targets.values()) {
      if (state.target.type !== 'agent') continue;
      if (safeEqual(state.target.agentKey, token)) {
        target = state.target;
        break;
      }
    }
    if (!target) return sendJson(req, res, 401, { error: 'Agent Token 无效' });
    let report;
    try {
      report = await readJsonBody(req, { limit: 64 * 1024 });
    } catch (error) {
      return sendJson(req, res, error.statusCode || 400, { error: error.message });
    }
    if (!report || typeof report !== 'object') {
      return sendJson(req, res, 400, { error: '上报内容必须是 JSON 对象' });
    }
    const receivedAt = Date.now();
    const agent = store.recordAgent(target.id, report, receivedAt);
    return sendJson(req, res, 200, {
      ok: true,
      node: { id: target.id, name: target.name },
      serverTime: receivedAt,
      intervalSeconds: target.intervalSeconds,
      hostname: agent?.hostname || '',
    });
  }

  async function route(req, res) {
    securityHeaders(req, res);
    const url = parseUrl(req);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(req, res, 400, { error: '请求路径不合法' });
    }

    if (pathname === '/healthz' || pathname === '/api/healthz') {
      return sendJson(req, res, 200, {
        ok: true,
        version,
        demo: config.isDemo === true,
        accountsRequired: accounts.required,
        uptimeSeconds: Math.floor((Date.now() - store.startedAt) / 1000),
        nodes: store.targets.size,
        time: new Date().toISOString(),
      });
    }

    if (pathname === '/api/auth/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleAuthStatus(req, res);
    }

    if (!sameOrigin(req) && req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 403, { error: '跨站请求被拒绝' });
    }

    if (pathname === '/api/auth/setup' && req.method === 'POST') return handleSetup(req, res);
    if (pathname === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res);
    if (pathname === '/api/auth/register' && req.method === 'POST') return handleRegister(req, res);
    if (pathname === '/api/auth/logout' && req.method === 'POST') return handleLogout(req, res);

    if (pathname === '/api/auth/setup' || pathname === '/api/auth/login' || pathname === '/api/auth/register') {
      res.setHeader('Allow', 'POST');
      return sendJson(req, res, 405, { error: 'Method Not Allowed' });
    }

    if (pathname === '/api/agent/report') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }
      return handleAgentReport(req, res);
    }

    const user = currentUser(req);

    if (pathname === '/api/account') {
      if (!user) return sendJson(req, res, 401, { error: '需要登录', loginRequired: true });
      return handleAccount(req, res, user);
    }

    if (pathname === '/api/admin/users' || pathname.startsWith('/api/admin/users/')) {
      if (!user) return sendJson(req, res, 401, { error: '需要登录', loginRequired: true });
      return handleAdminUsers(req, res, user, pathname, req.method);
    }

    if (pathname.startsWith('/api/')) {
      if (!readAllowed(req)) {
        return sendJson(req, res, 401, { error: '需要登录', loginRequired: true });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }
      if (pathname === '/api/overview') {
        return sendJson(req, res, 200, { ...store.overview(), version });
      }
      if (pathname === '/api/incidents') {
        const limit = Number(url.searchParams.get('limit') || 50);
        return sendJson(req, res, 200, { incidents: store.incidentsList(limit) });
      }
      const detailMatch = /^\/api\/targets\/([a-zA-Z0-9._-]+)$/.exec(pathname);
      if (detailMatch) {
        const detail = store.detail(detailMatch[1], url.searchParams.get('range') || '24h');
        if (!detail) return sendJson(req, res, 404, { error: '节点不存在' });
        return sendJson(req, res, 200, detail);
      }
      return sendJson(req, res, 404, { error: '接口不存在' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    }
    return serveStatic(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      log.error?.('[Eleganza] 请求处理失败:', error);
      if (!res.headersSent) sendJson(req, res, 500, { error: '服务器内部错误' });
      else res.end();
    });
  });
  server.app = { config, store, accounts };
  return server;
}
