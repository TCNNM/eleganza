import crypto from 'node:crypto';

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percentage(part, total) {
  if (!total) return null;
  return round((part / total) * 100, 2);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export async function readJsonBody(req, { limit = 128 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function relativeTime(value, now = Date.now()) {
  if (!value) return '—';
  const diff = Math.max(0, now - value);
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < HOUR) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

export function maskHost(host, { keep = 2 } = {}) {
  if (!host) return '—';
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/^\d+(\.\d+){3}$/.test(host)) {
    const parts = host.split('.');
    if (parts.length === 1) return host;
    const first = parts[0].replace(/^(.).*/, '$1***');
    return [first, ...parts.slice(1)].join('.');
  }
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const parts = host.split('.');
    return `${parts.slice(0, keep).join('.')}.*.*`;
  }
  if (host.includes(':')) {
    const [head, ...tail] = host.split(':');
    return `${head.slice(0, 4)}:…:${tail[tail.length - 1] || ''}`;
  }
  return host.length > 8 ? `${host.slice(0, 6)}…` : host;
}
