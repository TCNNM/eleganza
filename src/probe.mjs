import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { clamp, round } from './util.mjs';

const ERROR_TEXT = {
  ENOTFOUND: 'DNS 解析失败',
  EAI_AGAIN: 'DNS 暂时不可用',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ETIMEDOUT: '连接超时',
  EPIPE: '连接已断开',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链包含自签名证书',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书与域名不匹配',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 握手失败（版本不符）',
  ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: 'TLS 握手被拒绝',
};

export function describeError(error, timeoutMs) {
  if (!error) return '探测失败';
  if (error.code === 'POLARIS_TIMEOUT') return `探测超时（${timeoutMs} ms）`;
  if (ERROR_TEXT[error.code]) return ERROR_TEXT[error.code];
  if (error.code && /^ERR_/.test(error.code)) return `${error.code}：${error.message}`.slice(0, 160);
  if (error.code) return `${error.code} ${error.message || ''}`.trim().slice(0, 160);
  return (error.message || String(error)).slice(0, 160);
}

function timeoutError() {
  const error = new Error('probe timeout');
  error.code = 'POLARIS_TIMEOUT';
  return error;
}

function extractTls(socket) {
  try {
    const cert = socket.getPeerCertificate(true);
    if (!cert || !cert.valid_to) return null;
    const validTo = new Date(cert.valid_to).getTime();
    const daysLeft = Number.isFinite(validTo) ? (validTo - Date.now()) / 86_400_000 : null;
    return {
      subject: cert.subject?.CN || cert.subject?.O || '',
      issuer: cert.issuer?.CN || cert.issuer?.O || '',
      validFrom: new Date(cert.valid_from).toISOString(),
      validTo: new Date(validTo).toISOString(),
      daysLeft: daysLeft == null ? null : round(daysLeft, 1),
      authorized: socket.authorized !== false,
      authorizationError: socket.authorizationError ? String(socket.authorizationError).slice(0, 120) : '',
      protocol: socket.getProtocol ? socket.getProtocol() : '',
      fingerprint: cert.fingerprint256 ? String(cert.fingerprint256).slice(0, 32) : '',
    };
  } catch {
    return null;
  }
}

function requestOnce(url, { timeoutMs, allowInsecure, keyword, signal }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    let tls = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ...result, elapsed: performance.now() - started, tls });
    };
    const onAbort = () => {
      req.destroy(timeoutError());
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname || '/'}${url.search || ''}`,
        method: 'GET',
        headers: {
          'user-agent': 'Polaris-Probe/1.0 (+https://github.com/polaris-probe)',
          accept: '*/*',
          'accept-encoding': 'identity',
          connection: 'close',
        },
        rejectUnauthorized: !allowInsecure,
        servername: url.protocol === 'https:' ? url.hostname : undefined,
      },
      (res) => {
        const headersAt = performance.now();
        if (keyword) {
          let body = '';
          let bytes = 0;
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes <= 256 * 1024) body += chunk;
          });
          res.on('end', () => {
            const elapsed = performance.now() - started;
            finish({
              ok: true,
              code: res.statusCode,
              headers: res.headers,
              headersMs: headersAt - started,
              elapsed,
              body,
              keywordFound: body.includes(keyword),
            });
          });
          res.on('error', (error) => finish({ ok: false, code: res.statusCode, error: describeError(error, timeoutMs) }));
        } else {
          res.resume();
          res.on('error', () => {});
          finish({
            ok: true,
            code: res.statusCode,
            headers: res.headers,
            headersMs: headersAt - started,
            elapsed: headersAt - started,
          });
        }
      },
    );

    req.on('socket', (socket) => {
      if (socket.encrypted) {
        socket.once('secureConnect', () => {
          tls = extractTls(socket);
        });
      }
    });

    timer = setTimeout(() => {
      req.destroy(timeoutError());
    }, timeoutMs);
    req.on('error', (error) => {
      finish({ ok: false, error: describeError(error, timeoutMs) });
    });
    req.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

export async function probeHttp(target, options = {}) {
  const timeoutMs = options.timeoutMs || target.timeoutMs || 8000;
  const started = performance.now();
  let url = new URL(target.url);
  let chain = [];
  let tls = null;
  for (let hop = 0; hop < 5; hop += 1) {
    const result = await requestOnce(url, {
      timeoutMs: Math.max(500, timeoutMs - (performance.now() - started)),
      allowInsecure: target.allowInsecure,
      keyword: target.keyword,
      signal: options.signal,
    });
    if (result.tls) tls = result.tls;
    if (!result.ok) {
      return {
        ok: false,
        latencyMs: performance.now() - started,
        code: result.code ?? null,
        error: result.error || '请求失败',
        tls,
        meta: { chain },
      };
    }
    const status = result.code || 0;
    const location = result.headers?.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(status) && location;
    if (isRedirect && options.followRedirects !== false) {
      chain.push({ url: url.toString(), status });
      let next;
      try {
        next = new URL(location, url);
      } catch {
        break;
      }
      if (!/^https?:$/.test(next.protocol)) break;
      url = next;
      continue;
    }
    const expected = target.expectStatus;
    const statusOk = expected ? expected.includes(status) : status >= 200 && status < 400;
    if (!statusOk) {
      return {
        ok: false,
        latencyMs: result.elapsed,
        code: status,
        error: `状态码 ${status} 不在预期范围`,
        tls,
        meta: { chain, finalUrl: url.toString() },
      };
    }
    if (target.keyword && result.ok && result.keywordFound === false) {
      return {
        ok: false,
        latencyMs: result.elapsed,
        code: status,
        error: '响应内容未包含指定关键字',
        tls,
        meta: { chain, finalUrl: url.toString() },
      };
    }
    return {
      ok: true,
      latencyMs: result.elapsed,
      code: status,
      error: '',
      tls,
      meta: { chain, finalUrl: url.toString() },
    };
  }
  return {
    ok: false,
    latencyMs: performance.now() - started,
    code: null,
    error: '重定向次数过多',
    tls,
    meta: { chain },
  };
}

export function probeTcp(target, options = {}) {
  const timeoutMs = options.timeoutMs || target.timeoutMs || 8000;
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: target.host, port: target.port });
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve({ latencyMs: performance.now() - started, ...result });
    };
    socket.setNoDelay(true);
    socket.once('connect', () => finish({ ok: true, error: '', tls: null }));
    socket.once('error', (error) => finish({ ok: false, error: describeError(error, timeoutMs), tls: null }));
    timer = setTimeout(() => finish({ ok: false, error: `连接超时（${timeoutMs} ms）`, tls: null }), timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) finish({ ok: false, error: '已取消', tls: null });
      else options.signal.addEventListener('abort', () => finish({ ok: false, error: '已取消', tls: null }), { once: true });
    }
  });
}

export async function probeTarget(target, options = {}) {
  if (target.type === 'tcp') return probeTcp(target, options);
  if (target.type === 'http' || target.type === 'https') return probeHttp(target, options);
  return { ok: false, latencyMs: null, error: '不支持的探测类型', tls: null };
}

export class Prober {
  constructor({ store, config, log = console }) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.timers = new Map();
    this.inflight = new Map();
    this.stopped = false;
    this.sweepTimer = null;
  }

  start() {
    this.stopped = false;
    for (const state of this.store.targets.values()) {
      if (state.target.type === 'agent') continue;
      const delay = Math.floor(Math.random() * 1500);
      this.schedule(state.target, delay);
    }
    this.sweepTimer = setInterval(() => {
      this.store.sweep();
    }, 5000);
    this.sweepTimer.unref?.();
  }

  schedule(target, delay) {
    if (this.stopped) return;
    const timer = setTimeout(() => this.run(target), delay);
    timer.unref?.();
    this.timers.set(target.id, timer);
  }

  async run(target) {
    if (this.stopped) return;
    if (this.inflight.has(target.id)) return;
    const controller = new AbortController();
    this.inflight.set(target.id, controller);
    try {
      const result = await probeTarget(target, {
        timeoutMs: target.timeoutMs,
        signal: controller.signal,
      });
      this.store.recordSample(target.id, {
        t: Date.now(),
        ok: result.ok,
        latencyMs: result.latencyMs,
        code: result.code ?? null,
        error: result.error,
        tls: result.tls,
      });
    } catch (error) {
      this.store.recordSample(target.id, {
        t: Date.now(),
        ok: false,
        latencyMs: null,
        error: describeError(error, target.timeoutMs),
      });
    } finally {
      this.inflight.delete(target.id);
      if (!this.stopped) {
        const interval = clamp(target.intervalSeconds, 5, 3600) * 1000;
        const jitter = Math.floor(Math.random() * Math.min(2000, interval * 0.1));
        this.schedule(target, interval + jitter);
      }
    }
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }
}
