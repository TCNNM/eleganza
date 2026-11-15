import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { clamp, sha256 } from './util.mjs';

const TARGET_TYPES = new Set(['https', 'http', 'tcp', 'agent']);

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

export function resolveConfigPath(argv = process.argv.slice(2), env = process.env) {
  const flagIndex = argv.findIndex((arg) => arg === '--config' || arg === '-c');
  if (flagIndex >= 0 && argv[flagIndex + 1]) return path.resolve(argv[flagIndex + 1]);
  const inline = argv.find((arg) => arg.startsWith('--config='));
  if (inline) return path.resolve(inline.split('=')[1]);
  if (env.ELEGANZA_CONFIG) return path.resolve(env.ELEGANZA_CONFIG);
  if (argv.includes('--demo') || env.ELEGANZA_DEMO === '1') {
    return path.join(PROJECT_ROOT, 'config.demo.json');
  }
  return path.join(PROJECT_ROOT, 'config.json');
}

const DEFAULT_THRESHOLDS = {
  latencyWarnMs: 350,
  cpuWarnPercent: 80,
  memWarnPercent: 85,
  diskWarnPercent: 90,
  tlsWarnDays: 14,
  failureThreshold: 2,
};

const DEFAULT_SITE = {
  title: 'Eleganza',
  subtitle: '全球节点 · 实时探针',
  tagline: '让每一条线路，都清晰可见。',
  description: '从一台中枢出发，持续探测你的每一台服务器，把延迟、可用率、系统负载和证书状态收进同一张地图。',
  footer: 'Eleganza · 自建探针面板',
  locale: 'zh-CN',
  publicUrl: '',
  hub: { name: '探针中枢', lat: 31.2304, lon: 121.4737 },
  refreshSeconds: 10,
  public: true,
  showAddress: false,
  showDetails: true,
  trustProxy: false,
  historyDays: 35,
};

function normalizeTarget(raw, index, site, thresholds, demo) {
  if (!raw || typeof raw !== 'object') throw new Error(`targets[${index}] 必须是对象`);
  const id = String(raw.id || `node-${index + 1}`).trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) throw new Error(`targets[${index}].id 只能包含字母、数字、点、下划线、短横线`);
  const type = String(raw.type || 'https').toLowerCase();
  if (!TARGET_TYPES.has(type)) throw new Error(`targets[${index}].type 不支持: ${type}`);

  let host = raw.host ? String(raw.host).trim() : '';
  let port = raw.port != null ? Number(raw.port) : undefined;
  let url = raw.url ? String(raw.url).trim() : '';

  if (type === 'http' || type === 'https') {
    if (!url && host) url = `${type}://${host}${port ? `:${port}` : ''}`;
    if (!url) throw new Error(`targets[${index}] (${id}) 缺少 url 或 host`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`targets[${index}].url 不是合法 URL: ${url}`);
    }
    host = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    url = parsed.toString();
  }

  if (type === 'tcp') {
    if (!host) throw new Error(`targets[${index}] (${id}) 缺少 host`);
    port = Number(port || 443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`targets[${index}].port 非法`);
  }

  const expectStatus = Array.isArray(raw.expectStatus)
    ? raw.expectStatus.map(Number).filter(Number.isInteger)
    : null;

  const intervalSeconds = clamp(Number(raw.intervalSeconds || site.refreshSeconds || 10), 5, 3600);
  const target = {
    id,
    name: String(raw.name || id),
    group: raw.group ? String(raw.group) : '',
    country: raw.country ? String(raw.country).toUpperCase().slice(0, 2) : '',
    city: raw.city ? String(raw.city) : '',
    lat: Number.isFinite(Number(raw.lat)) ? Number(raw.lat) : null,
    lon: Number.isFinite(Number(raw.lon)) ? Number(raw.lon) : null,
    type,
    url,
    host,
    port,
    intervalSeconds,
    timeoutMs: clamp(Number(raw.timeoutMs || 8000), 1000, 30000),
    expectStatus: expectStatus && expectStatus.length ? expectStatus : null,
    keyword: raw.keyword ? String(raw.keyword) : '',
    allowInsecure: raw.allowInsecure === true,
    services: Array.isArray(raw.services) ? raw.services.map(String).slice(0, 24) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 8) : [],
    agentKey: raw.agentKey ? String(raw.agentKey) : '',
    hidden: raw.hidden === true,
    note: raw.note ? String(raw.note) : '',
    thresholds: { ...thresholds, ...(raw.thresholds || {}) },
  };

  if (type === 'agent' && !target.agentKey && !demo) {
    throw new Error(`targets[${index}] (${id}) 是 agent 类型，必须配置 agentKey（openssl rand -hex 24）`);
  }
  if (type === 'agent' && !demo) {
    const key = target.agentKey.trim();
    if (/^(?:请替换.*|change[_-]?me|replace[_-]?me|your[-_ ]?(agent[-_ ]?)?token|agent[-_ ]?token|<.*>)$/i.test(key)) {
      throw new Error(`targets[${index}] (${id}) 的 agentKey 仍是示例占位符；请用 openssl rand -hex 24 生成，并同步到 Agent 的 ELEGANZA_TOKEN`);
    }
  }
  if (type === 'agent' && !target.agentKey && demo) {
    target.agentKey = `demo-${sha256(id).slice(0, 24)}`;
  }
  if (target.lat == null || target.lon == null) {
    target.lat = null;
    target.lon = null;
  } else {
    target.lat = clamp(target.lat, -85, 85);
    target.lon = ((target.lon + 180) % 360 + 360) % 360 - 180;
  }
  return target;
}

export function loadConfig(file, { demo = false } = {}) {
  if (!existsSync(file)) {
    throw new Error(`配置文件不存在: ${file}\n复制 config.example.json 为 config.json 后再启动。`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`配置解析失败 (${file}): ${error.message}`);
  }
  const isDemo = demo || raw.demo === true;
  const site = { ...DEFAULT_SITE, ...(raw.site || {}) };
  site.hub = { ...DEFAULT_SITE.hub, ...(raw.site?.hub || {}) };
  site.historyDays = clamp(Number(site.historyDays || 35), 30, 90);
  site.refreshSeconds = clamp(Number(site.refreshSeconds || 10), 5, 120);
  site.public = site.public !== false;
  const publicUrl = String(site.publicUrl || '').trim();
  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      site.publicUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
    } catch {
      site.publicUrl = '';
    }
  } else {
    site.publicUrl = '';
  }

  const thresholds = { ...DEFAULT_THRESHOLDS, ...(raw.thresholds || {}) };
  const targets = (raw.targets || []).map((target, index) => normalizeTarget(target, index, site, thresholds, isDemo));
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.id)) throw new Error(`target id 重复: ${target.id}`);
    seen.add(target.id);
  }

  const accounts = {
    required: raw.accounts?.required === true || site.public === false,
    allowRegistration: raw.accounts?.allowRegistration === true,
    sessionHours: clamp(Number(raw.accounts?.sessionHours || 168), 1, 24 * 365),
    setupToken: raw.accounts?.setupToken ? String(raw.accounts.setupToken) : '',
  };

  return {
    file,
    isDemo,
    site,
    accounts,
    thresholds,
    targets,
    notifications: raw.notifications || {},
    legacyPasswordAuth: Boolean(raw.auth?.passwordSha256 || raw.auth?.password),
    dataDir: path.resolve(path.dirname(file), raw.dataDir || 'data'),
  };
}
