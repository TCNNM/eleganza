import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DAY, HOUR, maskHost, percentage, relativeTime, round } from './util.mjs';

const RING_SIZE = 180;
const INCIDENT_LIMIT = 300;
const STATE_VERSION = 1;

function emptyBucket(hour) {
  return {
    hour,
    up: 0,
    total: 0,
    latSum: 0,
    latN: 0,
    latMax: 0,
    cpuSum: 0,
    memSum: 0,
    diskSum: 0,
    metricN: 0,
    netInSum: 0,
    netOutSum: 0,
    netN: 0,
    tlsDaysMin: null,
  };
}

function createState(target) {
  return {
    target,
    status: 'pending',
    since: null,
    lastCheck: null,
    lastOk: null,
    failures: 0,
    error: '',
    tls: null,
    samples: [],
    buckets: new Map(),
    agent: null,
    metrics: null,
    services: [],
    lastMissAt: 0,
  };
}

function toBucketArray(bucket) {
  return [
    bucket.hour,
    bucket.up,
    bucket.total,
    round(bucket.latSum, 1) || 0,
    bucket.latN,
    round(bucket.latMax, 1) || 0,
    round(bucket.cpuSum, 1) || 0,
    round(bucket.memSum, 1) || 0,
    round(bucket.diskSum, 1) || 0,
    bucket.metricN,
    Math.round(bucket.netInSum),
    Math.round(bucket.netOutSum),
    bucket.netN,
    bucket.tlsDaysMin == null ? null : round(bucket.tlsDaysMin, 1),
  ];
}

function fromBucketArray(row) {
  const bucket = emptyBucket(row[0]);
  bucket.up = row[1] || 0;
  bucket.total = row[2] || 0;
  bucket.latSum = row[3] || 0;
  bucket.latN = row[4] || 0;
  bucket.latMax = row[5] || 0;
  bucket.cpuSum = row[6] || 0;
  bucket.memSum = row[7] || 0;
  bucket.diskSum = row[8] || 0;
  bucket.metricN = row[9] || 0;
  bucket.netInSum = row[10] || 0;
  bucket.netOutSum = row[11] || 0;
  bucket.netN = row[12] || 0;
  bucket.tlsDaysMin = row[13] == null ? null : row[13];
  return bucket;
}

function agentStaleAfter(target) {
  return Math.max(90_000, target.intervalSeconds * 3000);
}

const FLAG_REASONS = {
  cpu: 'CPU 偏高',
  mem: '内存偏高',
  disk: '磁盘偏高',
  latency: '延迟偏高',
  tls: '证书临期',
};

export class Store {
  constructor({ config, log = console }) {
    this.config = config;
    this.site = config.site;
    this.log = log;
    this.startedAt = Date.now();
    this.stateFile = path.join(config.dataDir, 'state.json');
    this.targets = new Map();
    for (const target of config.targets) this.targets.set(target.id, createState(target));
    this.incidents = [];
    this.eventHandlers = [];
    this.lastSavedAt = 0;
    this.saveTimer = null;
    this.saving = null;
    this.dirty = false;
  }

  // ---------------------------------------------------------------- lifecycle

  async load() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') this.log.warn?.(`状态文件读取失败，忽略: ${error.message}`);
      return false;
    }
    if (!raw || raw.version !== STATE_VERSION) return false;
    this.incidents = Array.isArray(raw.incidents) ? raw.incidents.slice(0, INCIDENT_LIMIT) : [];
    for (const [id, state] of this.targets) {
      const saved = raw.targets?.[id];
      if (!saved) continue;
      state.status = saved.status || 'pending';
      state.since = saved.since || null;
      state.lastCheck = saved.lastCheck || null;
      state.lastOk = saved.lastOk || null;
      state.failures = saved.failures || 0;
      state.error = saved.error || '';
      state.tls = saved.tls || null;
      state.samples = Array.isArray(saved.samples) ? saved.samples.slice(-RING_SIZE) : [];
      state.agent = saved.agent || null;
      state.metrics = saved.metrics || null;
      state.services = Array.isArray(saved.services) ? saved.services : [];
      for (const row of saved.buckets || []) {
        const bucket = fromBucketArray(row);
        state.buckets.set(bucket.hour, bucket);
      }
    }
    this.pruneBuckets();
    this.log.info?.(`已恢复历史状态：${this.targets.size} 个节点，${this.incidents.length} 条事件`);
    return true;
  }

  startPersistence() {
    if (this.saveTimer) return;
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.save().catch((error) => this.log.warn?.(`状态保存失败: ${error.message}`));
    }, 20_000);
    this.saveTimer.unref?.();
  }

  async close() {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  async save() {
    if (this.saving) return this.saving;
    this.saving = (async () => {
      const targets = {};
      for (const [id, state] of this.targets) {
        targets[id] = {
          status: state.status,
          since: state.since,
          lastCheck: state.lastCheck,
          lastOk: state.lastOk,
          failures: state.failures,
          error: state.error,
          tls: state.tls,
          samples: state.samples.slice(-RING_SIZE),
          buckets: [...state.buckets.values()]
            .sort((a, b) => a.hour - b.hour)
            .map(toBucketArray),
          agent: state.agent,
          metrics: state.metrics,
          services: state.services,
        };
      }
      const payload = {
        version: STATE_VERSION,
        savedAt: Date.now(),
        incidents: this.incidents.slice(0, INCIDENT_LIMIT),
        targets,
      };
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(payload));
      await rename(tmp, this.stateFile);
      this.lastSavedAt = Date.now();
      this.dirty = false;
    })()
      .catch((error) => {
        this.log.warn?.(`状态保存失败: ${error.message}`);
      })
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }

  markDirty() {
    this.dirty = true;
  }

  // ------------------------------------------------------------------ writing

  recordSample(id, sample) {
    const state = this.targets.get(id);
    if (!state) return null;
    const now = sample.t || Date.now();
    const ok = sample.ok === true;
    const latency = ok && Number.isFinite(sample.latencyMs) ? Math.max(0, sample.latencyMs) : null;

    const entry = {
      t: now,
      ok,
      latencyMs: latency == null ? null : round(latency, 1),
      code: sample.code ?? null,
      error: ok ? '' : String(sample.error || '探测失败').slice(0, 200),
    };
    state.samples.push(entry);
    if (state.samples.length > RING_SIZE) state.samples.splice(0, state.samples.length - RING_SIZE);
    state.lastCheck = now;
    this.updateBucket(state, {
      t: now,
      ok,
      latency,
      tls: sample.tls,
      metrics: sample.metrics,
      netInRate: sample.netInRate,
      netOutRate: sample.netOutRate,
    });

    if (ok) {
      state.failures = 0;
      state.lastOk = now;
      state.error = '';
      if (sample.tls) state.tls = sample.tls;
      if (state.status !== 'online') {
        state.status = 'online';
        state.since = now;
        this.closeIncident(id, now);
      }
    } else {
      state.failures += 1;
      state.error = entry.error;
      const threshold = state.target.thresholds?.failureThreshold || 2;
      if (state.failures >= threshold && state.status !== 'offline') {
        state.status = 'offline';
        state.since = now;
        this.openIncident(id, now, entry.error);
      }
    }
    this.markDirty();
    return entry;
  }

  recordAgent(id, report, now = Date.now()) {
    const state = this.targets.get(id);
    if (!state) return null;
    const previous = state.agent;
    const net = report.net || {};
    let rxRate = null;
    let txRate = null;
    if (previous?.at && Number.isFinite(net.rxBytes) && Number.isFinite(previous.rxBytes)) {
      const seconds = Math.max(1, (now - previous.at) / 1000);
      rxRate = Math.max(0, (net.rxBytes - previous.rxBytes) / seconds);
      txRate = Math.max(0, (net.txBytes - previous.txBytes) / seconds);
    }

    const clampPercent = (value) => (Number.isFinite(value) ? round(Math.min(100, Math.max(0, value)), 1) : null);
    const cpu = clampPercent(Number(report.cpu?.usage));
    const memUsed = Number(report.memory?.used);
    const memTotal = Number(report.memory?.total);
    const memPercent = clampPercent(memTotal > 0 ? (memUsed / memTotal) * 100 : Number(report.memory?.percent));
    const disks = Array.isArray(report.disks) ? report.disks.slice(0, 8).map((disk) => {
      const total = Number(disk.total) || 0;
      const used = Number(disk.used) || 0;
      const percent = disk.percent != null
        ? clampPercent(Number(disk.percent))
        : clampPercent(total > 0 ? (used / total) * 100 : null);
      return { mount: String(disk.mount || '/'), used, total, percent };
    }) : [];
    const primary = disks.find((disk) => disk.mount === '/') || disks[0] || null;

    const agent = {
      hostname: String(report.hostname || previous?.hostname || '').slice(0, 80),
      platform: String(report.platform || previous?.platform || '').slice(0, 120),
      kernel: String(report.kernel || previous?.kernel || '').slice(0, 160),
      version: String(report.agentVersion || previous?.version || '').slice(0, 40),
      cores: Number(report.cpu?.cores) || previous?.cores || null,
      cpuModel: String(report.cpu?.model || previous?.cpuModel || '').slice(0, 120),
      uptimeSeconds: Number(report.uptimeSeconds) || null,
      load: Array.isArray(report.load)
        ? report.load.slice(0, 3).map((value) => (Number.isFinite(Number(value)) ? round(Number(value), 2) : 0))
        : null,
      rxBytes: Math.max(0, Number(net.rxBytes) || 0),
      txBytes: Math.max(0, Number(net.txBytes) || 0),
      at: now,
      receivedAt: now,
      latencyMs: Number.isFinite(Number(report.latencyMs)) ? Number(report.latencyMs) : null,
    };
    state.agent = agent;
    const metrics = {
      cpu,
      mem: memPercent,
      memUsed: Number.isFinite(memUsed) ? memUsed : null,
      memTotal: Number.isFinite(memTotal) ? memTotal : null,
      disk: primary && Number.isFinite(primary.percent) ? primary.percent : null,
      disks,
      load: agent.load,
      uptimeSeconds: agent.uptimeSeconds,
      net: { rxRate, txRate, rxBytes: agent.rxBytes, txBytes: agent.txBytes },
    };
    state.metrics = metrics;
    state.services = Array.isArray(report.services)
      ? report.services.slice(0, 32).map((service) => ({
        name: String(service.name || '').slice(0, 64),
        active: service.active !== false,
      })).filter((service) => service.name)
      : state.services;

    this.recordSample(id, {
      t: now,
      ok: true,
      latencyMs: report.latencyMs,
      code: null,
      metrics,
      netInRate: rxRate,
      netOutRate: txRate,
    });
    return agent;
  }

  sweep(now = Date.now()) {
    let changed = false;
    for (const state of this.targets.values()) {
      if (state.target.type !== 'agent') continue;
      const lastSeen = state.agent?.at;
      if (!lastSeen) {
        if (state.status === 'pending' && state.lastCheck == null) continue;
        continue;
      }
      const staleAfter = agentStaleAfter(state.target);
      if (now - lastSeen > staleAfter && now - state.lastMissAt > staleAfter) {
        state.lastMissAt = now;
        const threshold = state.target.thresholds?.failureThreshold || 2;
        if (state.status !== 'offline') state.failures = Math.max(state.failures, threshold - 1);
        this.recordSample(state.target.id, {
          t: now,
          ok: false,
          error: `Agent 已 ${relativeTime(lastSeen, now)} 未上报（阈值 ${Math.round(staleAfter / 1000)} 秒）`,
        });
        changed = true;
      }
    }
    if (changed) this.markDirty();
    return changed;
  }

  updateBucket(state, sample) {
    const hour = Math.floor(sample.t / HOUR);
    let bucket = state.buckets.get(hour);
    if (!bucket) {
      bucket = emptyBucket(hour);
      state.buckets.set(hour, bucket);
    }
    bucket.total += 1;
    if (sample.ok) bucket.up += 1;
    if (Number.isFinite(sample.latency)) {
      bucket.latSum += sample.latency;
      bucket.latN += 1;
      bucket.latMax = Math.max(bucket.latMax, sample.latency);
    }
    if (sample.tls?.daysLeft != null) {
      bucket.tlsDaysMin = bucket.tlsDaysMin == null
        ? sample.tls.daysLeft
        : Math.min(bucket.tlsDaysMin, sample.tls.daysLeft);
    }
    if (sample.metrics) {
      const values = [sample.metrics.cpu, sample.metrics.mem, sample.metrics.disk].filter((value) => Number.isFinite(value));
      if (values.length) {
        bucket.metricN += 1;
        if (Number.isFinite(sample.metrics.cpu)) bucket.cpuSum += sample.metrics.cpu;
        if (Number.isFinite(sample.metrics.mem)) bucket.memSum += sample.metrics.mem;
        if (Number.isFinite(sample.metrics.disk)) bucket.diskSum += sample.metrics.disk;
      }
    }
    if (Number.isFinite(sample.netInRate) || Number.isFinite(sample.netOutRate)) {
      bucket.netN += 1;
      bucket.netInSum += sample.netInRate || 0;
      bucket.netOutSum += sample.netOutRate || 0;
    }
    this.pruneBuckets();
  }

  pruneBuckets(now = Date.now()) {
    const cutoffHour = Math.floor((now - this.site.historyDays * DAY) / HOUR);
    for (const state of this.targets.values()) {
      for (const hour of state.buckets.keys()) {
        if (hour < cutoffHour) state.buckets.delete(hour);
      }
    }
  }

  // ---------------------------------------------------------------- incidents

  onEvent(handler) {
    if (typeof handler === 'function') this.eventHandlers.push(handler);
  }

  emitEvent(event, incident) {
    const state = this.targets.get(incident.targetId);
    let node = null;
    if (state) {
      try {
        node = this.targetSummary(state);
      } catch {
        node = null;
      }
    }
    for (const handler of this.eventHandlers) {
      try {
        Promise.resolve(handler(event, { ...incident }, node)).catch((error) => {
          this.log.warn?.(`[Polaris] 事件处理失败: ${error.message}`);
        });
      } catch (error) {
        this.log.warn?.(`[Polaris] 事件处理失败: ${error.message}`);
      }
    }
  }

  openIncident(id, at, error) {
    const state = this.targets.get(id);
    if (!state) return;
    if (this.incidents.some((incident) => incident.targetId === id && !incident.endedAt)) return;
    this.incidents.unshift({
      id: `inc_${at.toString(36)}_${id}`,
      targetId: id,
      targetName: state.target.name,
      startedAt: at,
      endedAt: null,
      error: error || '探测失败',
    });
    if (this.incidents.length > INCIDENT_LIMIT) this.incidents.length = INCIDENT_LIMIT;
    this.markDirty();
    this.emitEvent('incident.opened', this.incidents[0]);
  }

  closeIncident(id, at) {
    const incident = this.incidents.find((item) => item.targetId === id && !item.endedAt);
    if (!incident) return;
    incident.endedAt = at;
    incident.durationMs = Math.max(0, at - incident.startedAt);
    this.markDirty();
    this.emitEvent('incident.resolved', incident);
  }

  // ------------------------------------------------------------------ reading

  warningReasons(state, now = Date.now()) {
    const reasons = [];
    const t = state.target.thresholds || this.config.thresholds;
    const last = [...state.samples].reverse().find((sample) => sample.ok && sample.latencyMs != null);
    if (state.status === 'online' && last && last.latencyMs > t.latencyWarnMs) reasons.push('latency');
    if (state.status === 'online' && state.metrics) {
      if (state.metrics.cpu != null && state.metrics.cpu >= t.cpuWarnPercent) reasons.push('cpu');
      if (state.metrics.mem != null && state.metrics.mem >= t.memWarnPercent) reasons.push('mem');
      if (state.metrics.disk != null && state.metrics.disk >= t.diskWarnPercent) reasons.push('disk');
    }
    if (state.status === 'online' && state.target.type !== 'agent' && state.tls?.daysLeft != null && state.tls.daysLeft <= t.tlsWarnDays) {
      reasons.push('tls');
    }
    return reasons;
  }

  resolveStatus(state, now = Date.now()) {
    if (state.status === 'online' && this.warningReasons(state, now).length) return 'warning';
    if (state.status === 'pending') {
      if (state.target.type === 'agent' && state.agent?.at) return 'online';
      return 'pending';
    }
    return state.status;
  }

  dayStats(state, dayStart, now) {
    let up = 0;
    let total = 0;
    let latSum = 0;
    let latN = 0;
    let cpuSum = 0;
    let memSum = 0;
    let metricN = 0;
    for (const bucket of state.buckets.values()) {
      const start = bucket.hour * HOUR;
      if (start < dayStart || start >= dayStart + DAY) continue;
      up += bucket.up;
      total += bucket.total;
      latSum += bucket.latSum;
      latN += bucket.latN;
      cpuSum += bucket.cpuSum;
      memSum += bucket.memSum;
      metricN += bucket.metricN;
    }
    return {
      up,
      total,
      availability: percentage(up, total),
      latency: latN ? round(latSum / latN, 1) : null,
      cpu: metricN ? round(cpuSum / metricN, 1) : null,
      mem: metricN ? round(memSum / metricN, 1) : null,
      hasData: total > 0,
    };
  }

  dailySeries(state, days = 30, now = Date.now()) {
    const base = new Date(now);
    const out = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset);
      const start = day.getTime();
      const stats = this.dayStats(state, start, now);
      let level = 'empty';
      if (stats.hasData) {
        if (stats.availability >= 99) level = 'up';
        else if (stats.availability >= 95) level = 'partial';
        else level = 'down';
      }
      out.push({
        date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
        start,
        up: stats.up,
        total: stats.total,
        availability: stats.availability,
        latency: stats.latency,
        cpu: stats.cpu,
        mem: stats.mem,
        level,
      });
    }
    return out;
  }

  availability(state, since, now = Date.now()) {
    let up = 0;
    let total = 0;
    const fromHour = Math.floor(since / HOUR);
    const toHour = Math.floor(now / HOUR);
    for (const [hour, bucket] of state.buckets) {
      if (hour < fromHour || hour > toHour) continue;
      up += bucket.up;
      total += bucket.total;
    }
    return { up, total, availability: percentage(up, total) };
  }

  latestLatency(state) {
    for (let i = state.samples.length - 1; i >= 0; i -= 1) {
      if (state.samples[i].ok && state.samples[i].latencyMs != null) return state.samples[i].latencyMs;
    }
    return null;
  }

  targetSummary(state, now = Date.now()) {
    const target = state.target;
    const status = this.resolveStatus(state, now);
    const reasons = status === 'warning' ? this.warningReasons(state, now) : [];
    const tls = state.tls
      ? {
        daysLeft: state.tls.daysLeft == null ? null : round(state.tls.daysLeft, 1),
        issuer: state.tls.issuer || '',
        subject: state.tls.subject || '',
        validFrom: state.tls.validFrom || null,
        validTo: state.tls.validTo || null,
        protocol: state.tls.protocol || '',
        authorized: state.tls.authorized !== false,
      }
      : null;
    const day30 = this.availability(state, now - 30 * DAY, now);
    const rawHost = target.type === 'agent' ? (state.agent?.hostname || 'agent 推送') : target.host;
    const displayHost = this.site.showAddress ? rawHost : maskHost(rawHost);
    const endpoint = target.type === 'agent'
      ? displayHost
      : `${displayHost}${target.port ? `:${target.port}` : ''}`;
    return {
      id: target.id,
      name: target.name,
      group: target.group,
      country: target.country,
      city: target.city,
      lat: target.lat,
      lon: target.lon,
      type: target.type,
      tags: target.tags,
      note: target.note,
      status,
      reasons: reasons.map((key) => FLAG_REASONS[key]).filter(Boolean),
      reasonKeys: reasons,
      latencyMs: this.latestLatency(state),
      lastCheck: state.lastCheck,
      lastOk: state.lastOk,
      since: state.since,
      error: this.site.showDetails ? state.error : (state.status === 'offline' ? '探针暂时无法完成检查' : ''),
      endpoint,
      availability30d: day30.availability,
      checks30d: day30.total,
      daily: this.dailySeries(state, 30, now),
      sparkline: state.samples.slice(-60).map((sample) => ({
        t: sample.t,
        latency: sample.latencyMs,
        ok: sample.ok,
      })),
      tls,
      metrics: state.metrics ? {
        cpu: state.metrics.cpu,
        mem: state.metrics.mem,
        disk: state.metrics.disk,
        load: state.metrics.load,
        net: state.metrics.net,
      } : null,
      agent: state.agent ? {
        hostname: state.agent.hostname,
        platform: state.agent.platform,
        version: state.agent.version,
        cores: state.agent.cores,
        uptimeSeconds: state.agent.uptimeSeconds,
        lastSeen: state.agent.at,
        latencyMs: state.agent.latencyMs,
      } : null,
      services: state.services,
      intervalSeconds: target.intervalSeconds,
      hidden: target.hidden,
    };
  }

  overview(now = Date.now()) {
    const states = [...this.targets.values()].filter((state) => !state.target.hidden);
    const targets = states.map((state) => this.targetSummary(state, now));
    const counts = { total: targets.length, online: 0, warning: 0, offline: 0, pending: 0 };
    for (const target of targets) counts[target.status] += 1;
    const latencies = targets.map((target) => target.latencyMs).filter((value) => Number.isFinite(value));
    const avgLatency = latencies.length ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length, 1) : null;
    let up = 0;
    let total = 0;
    for (const state of states) {
      const stats = this.availability(state, now - 30 * DAY, now);
      up += stats.up;
      total += stats.total;
    }
    const openIncidents = this.incidents.filter((incident) => !incident.endedAt);
    const overall = counts.offline > 0 ? 'critical' : (counts.warning > 0 ? 'degraded' : (counts.pending === counts.total ? 'pending' : 'operational'));
    return {
      generatedAt: now,
      startedAt: this.startedAt,
      site: {
        title: this.site.title,
        subtitle: this.site.subtitle,
        tagline: this.site.tagline,
        description: this.site.description,
        footer: this.site.footer,
        locale: this.site.locale,
        hub: this.site.hub,
        refreshSeconds: this.site.refreshSeconds,
        public: this.site.public,
        showAddress: this.site.showAddress,
      },
      summary: {
        ...counts,
        overall,
        avgLatency,
        availability30d: percentage(up, total),
        checks30d: total,
        openIncidents: openIncidents.length,
        lastUpdated: states.reduce((latest, state) => Math.max(latest, state.lastCheck || 0), 0) || null,
      },
      incidents: openIncidents.slice(0, 6),
      targets,
    };
  }

  incidentsList(limit = 50, now = Date.now()) {
    return this.incidents.slice(0, Math.max(1, Math.min(limit, 200))).map((incident) => ({
      ...incident,
      durationMs: incident.durationMs ?? (incident.endedAt ? incident.endedAt - incident.startedAt : now - incident.startedAt),
      ongoing: !incident.endedAt,
    }));
  }

  hourlyPoints(state, sinceHour, now) {
    const points = [];
    const currentHour = Math.floor(now / HOUR);
    for (let hour = sinceHour; hour <= currentHour; hour += 1) {
      const bucket = state.buckets.get(hour);
      if (!bucket) {
        points.push({ t: hour * HOUR, latency: null, availability: null, cpu: null, mem: null, up: 0, total: 0 });
        continue;
      }
      points.push({
        t: hour * HOUR,
        latency: bucket.latN ? round(bucket.latSum / bucket.latN, 1) : null,
        availability: percentage(bucket.up, bucket.total),
        cpu: bucket.metricN ? round(bucket.cpuSum / bucket.metricN, 1) : null,
        mem: bucket.metricN ? round(bucket.memSum / bucket.metricN, 1) : null,
        up: bucket.up,
        total: bucket.total,
      });
    }
    return points;
  }

  detail(id, range = '24h', now = Date.now()) {
    const state = this.targets.get(id);
    if (!state) return null;
    const allowed = new Set(['1h', '24h', '7d', '30d']);
    const key = allowed.has(range) ? range : '24h';
    let points;
    let since;
    if (key === '1h') {
      since = now - HOUR;
      points = state.samples
        .filter((sample) => sample.t >= since)
        .map((sample) => ({
          t: sample.t,
          latency: sample.ok ? sample.latencyMs : null,
          availability: sample.ok ? 100 : 0,
          cpu: null,
          mem: null,
          up: sample.ok ? 1 : 0,
          total: 1,
        }));
    } else if (key === '24h') {
      since = now - 24 * HOUR;
      points = this.hourlyPoints(state, Math.floor(since / HOUR), now);
    } else if (key === '7d') {
      since = now - 7 * DAY;
      points = this.hourlyPoints(state, Math.floor(since / HOUR), now);
    } else {
      since = now - 30 * DAY;
      points = this.dailySeries(state, 30, now).map((day) => ({
        t: day.start,
        latency: day.latency,
        availability: day.availability,
        cpu: day.cpu,
        mem: day.mem,
        up: day.up,
        total: day.total,
      }));
    }
    const stats = this.availability(state, since, now);
    const latencies = points.map((point) => point.latency).filter(Number.isFinite);
    const target = state.target;
    const incidents = this.incidentsList(200, now).filter((incident) => incident.targetId === id).slice(0, 20);
    return {
      range: key,
      generatedAt: now,
      target: this.targetSummary(state, now),
      summary: {
        availability: stats.availability,
        checks: stats.total,
        avgLatency: latencies.length ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length, 1) : null,
        minLatency: latencies.length ? round(Math.min(...latencies), 1) : null,
        maxLatency: latencies.length ? round(Math.max(...latencies), 1) : null,
      },
      points,
      incidents,
      config: {
        type: target.type,
        url: this.site.showAddress ? target.url : (target.url ? maskHost(target.host) : ''),
        host: this.site.showAddress ? target.host : maskHost(target.host),
        port: target.port,
        intervalSeconds: target.intervalSeconds,
        timeoutMs: target.timeoutMs,
        keyword: target.keyword ? true : false,
        tls: target.tls,
        services: target.services,
        agentKeyConfigured: Boolean(target.agentKey),
      },
      agent: state.agent ? {
        ...state.agent,
        lastSeen: state.agent.at,
      } : null,
      metrics: state.metrics,
      services: state.services,
      note: target.note,
    };
  }

  seededBuckets(id, buckets) {
    const state = this.targets.get(id);
    if (!state) return;
    for (const bucket of buckets) {
      state.buckets.set(bucket.hour, { ...emptyBucket(bucket.hour), ...bucket });
    }
    this.markDirty();
  }
}
