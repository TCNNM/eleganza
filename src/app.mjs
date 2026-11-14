import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseCookies, readJsonBody, safeEqual } from './util.mjs';
import { TOOLS } from './mcp.mjs';

export const VERSION = '1.0.0';

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

export function createPolarisServer({ config, store, auth, mcp, publicDir, version = VERSION, log = console }) {
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

  function isReadAuthorized(req) {
    if (config.site.public !== false) return true;
    return auth.readSession(parseCookies(req.headers.cookie));
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

  async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (!rateLimit(loginAttempts, ip, 8, 5 * 60 * 1000)) {
      return sendJson(req, res, 429, { error: '尝试次数过多，请稍后再试' });
    }
    let body;
    try {
      body = await readJsonBody(req, { limit: 8 * 1024 });
    } catch (error) {
      return sendJson(req, res, error.statusCode || 400, { error: error.message });
    }
    if (!auth.required) {
      return sendJson(req, res, 200, { ok: true, authenticated: true });
    }
    if (!auth.verifyPassword(String(body.password || ''))) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return sendJson(req, res, 401, { error: '密码不正确' });
    }
    res.setHeader('Set-Cookie', auth.cookieHeader({ secure: isSecure(req) }));
    return sendJson(req, res, 200, { ok: true, authenticated: true });
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

  async function handleMcp(req, res) {
    if (req.method === 'GET') {
      if (config.site.public === false && !isReadAuthorized(req) && !auth.authorizeBearer(req.headers.authorization)) {
        return sendJson(req, res, 401, { error: '需要登录或 Bearer Token' });
      }
      return sendJson(req, res, 200, {
        name: 'polaris',
        version,
        protocolVersion: '2025-06-18',
        transport: 'streamable-http (POST JSON-RPC)',
        endpoint: '/mcp',
        tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
      });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJson(req, res, 405, { error: 'Method Not Allowed' });
    }
    if (config.site.public === false && !isReadAuthorized(req) && !auth.authorizeBearer(req.headers.authorization)) {
      return sendJson(req, res, 401, { error: '需要登录或 Bearer Token' });
    }
    let body;
    try {
      body = await readJsonBody(req, { limit: 256 * 1024 });
    } catch (error) {
      return sendJson(req, res, error.statusCode || 400, { error: error.message });
    }
    if (Array.isArray(body)) {
      const results = [];
      for (const message of body) {
        const result = await mcp.handle(message);
        if (result) results.push(result);
      }
      if (!results.length) {
        res.writeHead(202);
        return res.end();
      }
      return sendJson(req, res, 200, results);
    }
    const result = await mcp.handle(body);
    if (!result) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(req, res, 200, result);
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

    if (pathname === '/mcp' || pathname === '/api/mcp') return handleMcp(req, res);

    if (pathname === '/healthz' || pathname === '/api/healthz') {
      return sendJson(req, res, 200, {
        ok: true,
        version,
        demo: config.isDemo === true,
        uptimeSeconds: Math.floor((Date.now() - store.startedAt) / 1000),
        nodes: store.targets.size,
        time: new Date().toISOString(),
      });
    }

    if (pathname === '/api/session') {
      const authenticated = isReadAuthorized(req);
      return sendJson(req, res, 200, {
        required: config.site.public === false,
        authenticated,
        site: { title: config.site.title, subtitle: config.site.subtitle },
      });
    }

    if (pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);

    if (pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', auth.clearCookieHeader({ secure: isSecure(req) }));
      return sendJson(req, res, 200, { ok: true });
    }

    if (pathname === '/api/agent/report') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }
      return handleAgentReport(req, res);
    }

    if (pathname.startsWith('/api/')) {
      if (!isReadAuthorized(req)) {
        return sendJson(req, res, 401, { error: '需要登录', loginRequired: true });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }
      if (pathname === '/api/overview') {
        return sendJson(req, res, 200, store.overview());
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
      log.error?.('[Polaris] 请求处理失败:', error);
      if (!res.headersSent) sendJson(req, res, 500, { error: '服务器内部错误' });
      else res.end();
    });
  });
  server.app = { config, store, auth, mcp };
  return server;
}
