// Deterministic demo data so the panel can be evaluated without touching a server.
import { DAY, HOUR, round } from './util.mjs';

const PROFILE = {
  'hk-core': { base: 16, cpu: 24, mem: 51, disk: 44, netIn: 2.4e6, netOut: 1.1e6, tlsDays: 86 },
  'hk-edge': { base: 21, cpu: 18, mem: 38, disk: 33, netIn: 0.9e6, netOut: 1.7e6 },
  'jp-tokyo': { base: 38, cpu: 41, mem: 63, disk: 58, netIn: 3.1e6, netOut: 2.2e6, tlsDays: 54 },
  'sg-relay': { base: 55, cpu: 12, mem: 29, disk: 26, netIn: 0.6e6, netOut: 0.8e6 },
  'us-lax': { base: 168, cpu: 33, mem: 57, disk: 61, netIn: 4.2e6, netOut: 3.4e6, tlsDays: 21 },
  'de-fra': { base: 205, cpu: 37, mem: 66, disk: 72, netIn: 3.4e6, netOut: 2.9e6, tlsDays: 9 },
  'uk-lon': { base: 198, cpu: 20, mem: 44, disk: 37, netIn: 1.1e6, netOut: 0.7e6 },
  'au-syd': { base: 246, cpu: 28, mem: 52, disk: 48, netIn: 1.8e6, netOut: 1.2e6 },
  'kr-seo': { base: 33, cpu: 47, mem: 71, disk: 63, netIn: 2.7e6, netOut: 1.9e6 },
  'in-bom': { base: 142, cpu: 31, mem: 49, disk: 41, netIn: 2.1e6, netOut: 1.4e6 },
};

const OUTAGES = {
  'de-fra': [{ hoursAgo: 6 * 24 + 3, hours: 2, error: '连接被重置' }],
  'us-lax': [{ hoursAgo: 12 * 24 + 7, hours: 1, error: '探测超时（8000 ms）' }],
  'sg-relay': [{ hoursAgo: 20 * 24 + 11, hours: 1, error: '连接被拒绝' }],
};

const SERVICES = ['nginx', 'xray', 'hysteria-server'];

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function diurnal(hourOfDay) {
  return 1 + 0.24 * Math.sin(((hourOfDay - 9) / 24) * Math.PI * 2);
}

function tlsInfo(daysLeft) {
  const validTo = new Date(Date.now() + daysLeft * DAY).toISOString();
  return {
    subject: 'eleganza-demo.example',
    issuer: "Let's Encrypt R11",
    validFrom: new Date(Date.now() - (90 - daysLeft) * DAY).toISOString(),
    validTo,
    daysLeft: round(daysLeft, 1),
    authorized: true,
    protocol: 'TLSv1.3',
  };
}

function makeAgent(target, profile, now, metrics) {
  return {
    hostname: `${target.id}.demo`,
    platform: 'Debian GNU/Linux 12 (bookworm)',
    kernel: '6.1.0-28-amd64',
    version: '1.0.0',
    cores: target.id === 'in-bom' ? 2 : 4,
    cpuModel: 'AMD EPYC 7B13',
    uptimeSeconds: 28 * 86400 + hashSeed(target.id) % 40000,
    load: [round(profile.cpu / 25, 2), round(profile.cpu / 30, 2), round(profile.cpu / 35, 2)],
    rxBytes: 4.2e12 + hashSeed(target.id) * 1e5,
    txBytes: 2.1e12 + hashSeed(target.id) * 1e5,
    at: now - 3000,
    receivedAt: now - 3000,
    latencyMs: profile.base,
    ...metrics,
  };
}

export function seedDemoData(store, config, now = Date.now()) {
  store.incidents = [];
  const currentHour = Math.floor(now / HOUR);
  const startHour = currentHour - 30 * 24 + 1;

  for (const state of store.targets.values()) {
    const target = state.target;
    const profile = PROFILE[target.id] || { base: 120, cpu: 25, mem: 45, disk: 40, netIn: 1e6, netOut: 1e6 };
    const random = mulberry32(hashSeed(target.id));
    const isAgent = target.type === 'agent';
    const isOffline = target.id === 'au-syd';
    const intervalMs = target.intervalSeconds * 1000;
    const tls = profile.tlsDays ? tlsInfo(profile.tlsDays) : null;

    state.buckets.clear();
    for (let hour = startHour; hour <= currentHour; hour += 1) {
      const hourStart = hour * HOUR;
      const hoursAgo = currentHour - hour;
      const date = new Date(hourStart);
      const factor = diurnal(date.getUTCHours());
      const outages = OUTAGES[target.id] || [];
      const outage = outages.find((item) => hoursAgo >= item.hoursAgo - item.hours && hoursAgo <= item.hoursAgo);
      const offlineNow = isOffline && hoursAgo < 3;
      const fullHour = hoursAgo > 0;
      const total = fullHour ? Math.max(1, Math.floor(HOUR / intervalMs)) : Math.max(1, Math.floor((now - hourStart) / intervalMs));
      const down = Boolean(outage || offlineNow);
      const flaky = !down && random() < 0.025;
      const up = down ? 0 : Math.max(0, total - (flaky ? 1 : 0));
      const latency = profile.base * factor * (0.9 + random() * 0.22);
      const cpu = Math.min(96, profile.cpu * factor * (0.85 + random() * 0.3));
      const mem = Math.min(95, profile.mem + (random() - 0.5) * 8);
      const disk = Math.min(97, profile.disk + hoursAgo * 0.004);
      const bucket = {
        hour,
        up,
        total,
        latSum: down ? 0 : latency * up,
        latN: down ? 0 : up,
        latMax: down ? 0 : latency * 1.8,
        cpuSum: isAgent ? cpu * total : 0,
        memSum: isAgent ? mem * total : 0,
        diskSum: isAgent ? disk * total : 0,
        metricN: isAgent ? total : 0,
        netInSum: isAgent ? profile.netIn * total : 0,
        netOutSum: isAgent ? profile.netOut * total : 0,
        netN: isAgent ? total : 0,
        tlsDaysMin: tls ? tls.daysLeft + hoursAgo / 24 : null,
      };
      state.buckets.set(hour, bucket);
    }

    state.samples = [];
    for (let i = 59; i >= 0; i -= 1) {
      const t = now - i * Math.max(intervalMs, 15_000);
      const failNow = isOffline && i < 14;
      const ok = !failNow;
      state.samples.push({
        t,
        ok,
        latencyMs: ok ? round(profile.base * diurnal(new Date(t).getUTCHours()) * (0.92 + random() * 0.2), 1) : null,
        code: ok ? 200 : null,
        error: ok ? '' : '连接超时（8000 ms）',
      });
    }

    state.tls = tls;
    if (isAgent) {
      const cpu = profile.cpu * diurnal(new Date(now).getUTCHours()) * (0.9 + random() * 0.2);
      const metrics = {
        cpu: round(cpu, 1),
        mem: round(profile.mem, 1),
        memUsed: profile.mem / 100 * 8 * 1024 ** 3,
        memTotal: 8 * 1024 ** 3,
        disk: round(profile.disk, 1),
        disks: [
          { mount: '/', used: profile.disk / 100 * 80 * 1024 ** 3, total: 80 * 1024 ** 3, percent: round(profile.disk, 1) },
          { mount: '/var', used: 12 * 1024 ** 3, total: 40 * 1024 ** 3, percent: 30 },
        ],
        load: [round(cpu / 25, 2), round(cpu / 30, 2), round(cpu / 35, 2)],
        uptimeSeconds: 28 * 86400,
        net: { rxRate: profile.netIn, txRate: profile.netOut, rxBytes: 4.2e12, txBytes: 2.1e12 },
      };
      state.metrics = metrics;
      state.agent = makeAgent(target, profile, now, {});
      state.services = SERVICES.map((name, index) => ({ name, active: index !== 2 || target.id !== 'kr-seo' }));
    } else {
      state.metrics = null;
      state.agent = null;
      state.services = SERVICES.slice(0, 2).map((name) => ({ name, active: true }));
    }

    state.lastCheck = isOffline ? now - 8000 : now - 2000 - Math.floor(random() * 3000);
    state.lastOk = isOffline ? now - 3 * HOUR : state.lastCheck;
    state.status = isOffline ? 'offline' : 'online';
    state.since = isOffline ? now - 3 * HOUR : now - 30 * DAY;
    state.failures = isOffline ? 24 : 0;
    state.error = isOffline ? '连接超时（8000 ms）' : '';
  }

  for (const [id, outages] of Object.entries(OUTAGES)) {
    for (const outage of outages) {
      const state = store.targets.get(id);
      if (!state) continue;
      const startedAt = now - outage.hoursAgo * HOUR;
      store.incidents.push({
        id: `inc_${startedAt.toString(36)}_${id}`,
        targetId: id,
        targetName: state.target.name,
        startedAt,
        endedAt: startedAt + outage.hours * HOUR,
        durationMs: outage.hours * HOUR,
        error: outage.error,
      });
    }
  }
  const offline = store.targets.get('au-syd');
  if (offline) {
    store.incidents.push({
      id: `inc_${(now - 3 * HOUR).toString(36)}_au-syd`,
      targetId: 'au-syd',
      targetName: offline.target.name,
      startedAt: now - 3 * HOUR,
      endedAt: null,
      error: '连接超时（8000 ms）',
    });
  }
  store.incidents.sort((a, b) => b.startedAt - a.startedAt);
  store.markDirty();
}

export class DemoSource {
  constructor({ store, config, log = console }) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.timer = null;
    this.counters = new Map();
    this.tickCount = 0;
  }

  start() {
    const interval = Math.max(5000, this.config.site.refreshSeconds * 1000);
    this.timer = setInterval(() => this.tick(), interval);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 500).unref?.();
    this.log.info?.('演示模式：使用生成的节点数据，不发起真实探测');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = Date.now();
    this.tickCount += 1;
    for (const state of this.store.targets.values()) {
      const target = state.target;
      const profile = PROFILE[target.id] || { base: 120, cpu: 25, mem: 45, disk: 40, netIn: 1e6, netOut: 1e6 };
      const random = Math.random();
      const factor = diurnal(new Date(now).getUTCHours());

      if (target.id === 'au-syd') {
        this.store.recordSample(target.id, { t: now, ok: false, error: '连接超时（8000 ms）' });
        continue;
      }

      if (target.type === 'agent') {
        const previous = this.counters.get(target.id) || {
          rx: profile.netIn * 1e6,
          tx: profile.netOut * 1e6,
        };
        previous.rx += profile.netIn * (5 + random * 4);
        previous.tx += profile.netOut * (5 + random * 4);
        this.counters.set(target.id, previous);
        const cpu = Math.min(97, Math.max(4, profile.cpu * factor * (0.75 + Math.random() * 0.45)));
        const mem = Math.min(95, Math.max(20, profile.mem + (Math.random() - 0.5) * 7));
        this.store.recordAgent(target.id, {
          hostname: `${target.id}.demo`,
          platform: 'Debian GNU/Linux 12 (bookworm)',
          kernel: '6.1.0-28-amd64',
          agentVersion: '1.0.0',
          uptimeSeconds: 28 * 86400 + (now / 1000) % 40000,
          cpu: { usage: round(cpu, 1), cores: target.id === 'in-bom' ? 2 : 4, model: 'AMD EPYC 7B13' },
          memory: { total: 8 * 1024 ** 3, used: (mem / 100) * 8 * 1024 ** 3 },
          disks: [{ mount: '/', total: 80 * 1024 ** 3, used: (profile.disk / 100) * 80 * 1024 ** 3 }],
          net: { rxBytes: previous.rx, txBytes: previous.tx },
          load: [round(cpu / 25, 2), round(cpu / 30, 2), round(cpu / 35, 2)],
          services: SERVICES.map((name, index) => ({ name, active: index !== 2 || target.id !== 'kr-seo' })),
          latencyMs: round(profile.base * factor * (0.9 + Math.random() * 0.2), 1),
        }, now);
        continue;
      }

      const latency = profile.base * factor * (0.88 + Math.random() * 0.26);
      const tls = profile.tlsDays ? tlsInfo(profile.tlsDays - (now / DAY) % 1) : null;
      this.store.recordSample(target.id, {
        t: now,
        ok: true,
        latencyMs: round(latency, 1),
        code: 200,
        tls,
      });
    }
  }
}
