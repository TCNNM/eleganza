import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const CACHE_TTL = 6 * 60 * 60 * 1000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const value = ip.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  }
  return true;
}

export class GeoLocator {
  constructor({ dataDir, log = console, fetchImpl = globalThis.fetch }) {
    this.dataDir = dataDir;
    this.cacheFile = path.join(dataDir, 'geo-cache.json');
    this.log = log;
    this.fetch = fetchImpl;
    this.cache = {};
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      if (raw && typeof raw === 'object' && raw.entries) this.cache = raw.entries;
    } catch (error) {
      if (error.code !== 'ENOENT') this.log.warn?.(`[geo] 缓存读取失败: ${error.message}`);
    }
  }

  async save() {
    try {
      await writeFile(this.cacheFile, `${JSON.stringify({ savedAt: Date.now(), entries: this.cache }, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.log.warn?.(`[geo] 缓存写入失败: ${error.message}`);
    }
  }

  async fetchJson(url) {
    const response = await this.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Eleganza/geo' },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  normalize(data, fallbackIp = '') {
    if (!data || typeof data !== 'object' || data.bogon) return null;
    const [lat, lon] = String(data.loc || '').split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      ip: String(data.ip || fallbackIp || ''),
      city: String(data.city || ''),
      region: String(data.region || ''),
      country: String(data.country || '').toUpperCase(),
      lat,
      lon,
      org: String(data.org || ''),
      at: Date.now(),
    };
  }

  async locateIp(ip) {
    const clean = String(ip || '').trim().replace(/^\[|\]$/g, '');
    if (!net.isIP(clean) || isPrivateIp(clean)) return null;
    const cached = this.cache[clean];
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached;

    try {
      const data = await this.fetchJson(`https://ipinfo.io/${encodeURIComponent(clean)}/json`);
      const location = this.normalize(data, clean);
      if (!location) return null;
      this.cache[clean] = location;
      await this.save();
      return location;
    } catch (error) {
      this.log.warn?.(`[geo] 无法定位 ${clean}: ${error.message}`);
      return null;
    }
  }

  async locateHost(host) {
    const value = String(host || '').trim().replace(/^\[|\]$/g, '');
    if (!value) return null;
    if (net.isIP(value)) return this.locateIp(value);
    try {
      const result = await dns.lookup(value, { family: 0, verbatim: true });
      return this.locateIp(result.address);
    } catch (error) {
      this.log.warn?.(`[geo] 无法解析 ${value}: ${error.message}`);
      return null;
    }
  }

  async locateUrl(url) {
    try {
      return await this.locateHost(new URL(url).hostname);
    } catch {
      return null;
    }
  }

  async locateEgress() {
    try {
      const data = await this.fetchJson('https://ipinfo.io/json');
      return this.normalize(data);
    } catch (error) {
      this.log.warn?.(`[geo] 无法定位面板出口 IP: ${error.message}`);
      return null;
    }
  }

  async applyPanelLocation(config, store) {
    // 面板服务器自己的出口 IP 优先；publicUrl 可能经过 CDN，不能代表安装机器。
    let location = await this.locateEgress();
    if (!location && config.site.publicUrl) location = await this.locateUrl(config.site.publicUrl);
    if (!location) return null;
    const city = location.city || location.region || location.country || '';
    config.site.hub = {
      name: '面板服务器',
      city,
      country: location.country,
      ip: location.ip,
      lat: location.lat,
      lon: location.lon,
    };
    store.site.hub = config.site.hub;
    this.log.info?.(`[geo] 探针中枢 = 面板服务器: ${city || '未知位置'} (${location.ip})`);
    return location;
  }

  async applyTargetLocations(store) {
    for (const state of store.targets.values()) {
      if (state.target.type === 'agent') continue;
      const location = await this.locateHost(state.target.host);
      if (location) {
        state.geo = location;
        store.markDirty?.();
      }
    }
  }
}
