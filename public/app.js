import { Globe } from './globe.js';
import { sparkline, TimeChart } from './charts.js';
import {
  ACCENTS,
  DEFAULT_PREFERENCES,
  STYLE_PRESETS,
  accentColor,
  applyPreferences,
  loadPreferences,
  normalizePreferences,
  savePreferences,
} from './theme.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STATUS_LABEL = {
  online: '正常',
  warning: '注意',
  offline: '离线',
  pending: '待探测',
};

const TYPE_LABEL = {
  https: 'HTTPS',
  http: 'HTTP',
  tcp: 'TCP',
  agent: 'Agent',
};

const STATE_ORDER = { offline: 0, warning: 1, pending: 2, online: 3 };

const state = {
  overview: null,
  incidents: [],
  filter: 'all',
  search: '',
  selectedId: null,
  range: '24h',
  detail: null,
  chart: null,
  metricChart: null,
  refreshing: false,
  booted: false,
  lastFocus: null,
  auth: null,
  authMode: 'login',
  authGate: false,
  prefs: { ...DEFAULT_PREFERENCES },
  prefSaveTimer: null,
};

const els = {
  clock: $('#clock'),
  refresh: $('#refresh-button'),
  probeCommandButton: $('#probe-command-button'),
  appearanceButton: $('#appearance-button'),
  appearancePopover: $('#appearance-popover'),
  accountButton: $('#account-button'),
  accountAvatar: $('#account-avatar'),
  accountPopover: $('#account-popover'),
  accountPopoverBody: $('#account-popover-body'),
  authModal: $('#auth-modal'),
  authForm: $('#auth-form'),
  authFields: $('#auth-fields'),
  authTitle: $('#auth-title'),
  authSubtitle: $('#auth-subtitle'),
  authSubmit: $('#auth-submit'),
  authAlt: $('#auth-alt'),
  authError: $('#auth-error'),
  authClose: $('#auth-close'),
  dialogModal: $('#dialog-modal'),
  dialogKicker: $('#dialog-kicker'),
  dialogTitle: $('#dialog-title'),
  dialogSubtitle: $('#dialog-subtitle'),
  dialogBody: $('#dialog-body'),
  prefScope: $('#pref-scope'),
  heroState: $('#hero-state'),
  heroTitle: $('#hero-title'),
  heroDesc: $('#hero-description'),
  heroAvailability: $('#hero-availability'),
  heroLatency: $('#hero-latency'),
  heroNodes: $('#hero-nodes'),
  heroUpdated: $('#hero-updated'),
  banner: $('#status-banner'),
  kpiTotal: $('#kpi-total'),
  kpiTotalFoot: $('#kpi-total-foot'),
  kpiTotal2: $('#kpi-total-2'),
  kpiOnline: $('#kpi-online'),
  kpiOnlineFoot: $('#kpi-online-foot'),
  kpiOnlineBar: $('#kpi-online-bar'),
  kpiLatency: $('#kpi-latency'),
  kpiLatencyFoot: $('#kpi-latency-foot'),
  kpiLatencyBars: $('#kpi-latency-bars'),
  kpiAvailability: $('#kpi-availability'),
  kpiAvailabilityFoot: $('#kpi-availability-foot'),
  kpiRing: $('#kpi-ring-value'),
  kpiDots: $('#kpi-status-dots'),
  filters: $('#filters'),
  search: $('#node-search'),
  grid: $('#node-grid'),
  empty: $('#node-empty'),
  nodesNote: $('#nodes-note'),
  incidentList: $('#incident-list'),
  incidentMeta: $('#incident-meta'),
  infoNodes: $('#info-nodes'),
  infoChecks: $('#info-checks'),
  infoHistory: $('#info-history'),
  infoUser: $('#info-user'),
  infoSync: $('#info-sync'),
  infoVersion: $('#info-version'),
  footerText: $('#footer-text'),
  footerRefresh: $('#footer-refresh'),
  globeToggle: $('#globe-toggle'),
  globeCoord: $('#globe-coord'),
  hubName: $('#hub-name'),
  legendOnline: $('#legend-online'),
  legendWarning: $('#legend-warning'),
  legendOffline: $('#legend-offline'),
  drawer: $('#drawer'),
  drawerBackdrop: $('#drawer-backdrop'),
  drawerContent: $('#drawer-content'),
};

let globe = null;
let detailSeq = 0;
let pollTimer = null;
let drawerHideTimer = null;

// ------------------------------------------------------------------ helpers

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US');
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Some HTTP origins expose the API but reject the write; use the fallback.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-9999px';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy failed');
}

function formatLatency(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value) < 100 ? Number(value).toFixed(1) : String(Math.round(Number(value)));
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(2);
}

function formatRelative(ms, now = Date.now()) {
  if (!ms) return '—';
  const diff = Math.max(0, now - ms);
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`;
}

function formatShortUptime(ms) {
  if (!ms) return '—';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
  return `${Math.floor(diff / 86_400_000)} 天`;
}

function formatUptimeSeconds(seconds) {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatMbps(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const bits = bytesPerSecond * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} Kbps`;
  return `${bits.toFixed(0)} bps`;
}

function statusPill(status) {
  const label = STATUS_LABEL[status] || status;
  return `<span class="status-pill ${status}"><i></i>${label}</span>`;
}

function iconAlert() {
  return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4 2.8 20h18.4L12 4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="17" r=".9" fill="currentColor"/></svg>';
}

function iconPause() {
  return '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.5 5v10M13.5 5v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
}

function iconPlay() {
  return '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 5 8 5-8 5V5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
}

function relativePillAgo(ms) {
  return formatRelative(ms);
}

// ------------------------------------------------------------------ network

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
    ...options,
  });
  if (response.status === 401) {
    const error = new Error('需要登录');
    error.loginRequired = true;
    throw error;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `请求失败（${response.status}）`);
  }
  return response.json();
}

let lastErrorToast = 0;

function toast(message) {
  const now = Date.now();
  if (now - lastErrorToast < 5000) return;
  lastErrorToast = now;
  let node = $('#toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.remove('is-visible'), 4200);
}

// ------------------------------------------------------------------ clock

function tickClock() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  els.clock.textContent = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// ------------------------------------------------------------------ rendering

function renderShell(overview) {
  const { site, summary, targets } = overview;
  document.title = `${site.title} — ${site.subtitle}`;
  els.heroDesc.textContent = site.description || '';
  els.footerText.textContent = site.footer || 'Eleganza';
  els.footerRefresh.textContent = '每 5 秒同步';
  els.hubName.textContent = site.hub?.name || '探针中枢';

  const stateText = {
    operational: '系统运行正常',
    degraded: '部分节点需注意',
    critical: '存在离线节点',
    pending: '等待首批数据',
  }[summary.overall] || '正在探测';
  els.heroState.textContent = stateText;
  els.heroState.classList.toggle('is-warn', summary.overall === 'degraded');
  els.heroState.classList.toggle('is-bad', summary.overall === 'critical');

  els.heroAvailability.textContent = summary.availability30d == null ? '—' : `${summary.availability30d.toFixed(2)}%`;
  els.heroLatency.textContent = summary.avgLatency == null ? '—' : `${formatLatency(summary.avgLatency)} ms`;
  els.heroNodes.textContent = `${summary.online} / ${summary.total}`;
  els.heroUpdated.textContent = summary.lastUpdated ? formatRelative(summary.lastUpdated) : '—';

  els.legendOnline.textContent = summary.online;
  els.legendWarning.textContent = summary.warning;
  els.legendOffline.textContent = summary.offline;

  renderKpis(overview);
  renderBanner(overview);
  renderFilters(overview);
  renderNodes();
  renderInfoPanel(overview);
  if (globe) {
    if (site.hub) globe.hub = site.hub;
    globe.setData(targets);
  }
}

function renderBanner(overview) {
  const { summary, targets } = overview;
  const offline = targets.filter((target) => target.status === 'offline');
  const warnings = targets.filter((target) => target.status === 'warning');
  if (!offline.length && !warnings.length) {
    els.banner.hidden = true;
    els.banner.innerHTML = '';
    return;
  }
  els.banner.hidden = false;
  els.banner.classList.toggle('is-warning', !offline.length);
  if (offline.length) {
    const first = offline[0];
    const more = offline.length > 1 ? `，另有 ${offline.length - 1} 个节点离线` : '';
    els.banner.innerHTML = `
      <span class="banner-icon">${iconAlert()}</span>
      <div class="banner-copy">
        <strong>${escapeHtml(first.name)} 当前无法连通</strong>
        <span>${escapeHtml(first.error || '探测失败')} · 已持续 ${formatDuration(Date.now() - (first.since || Date.now()))}${more}</span>
      </div>
      <button class="banner-action" type="button" data-filter="offline">查看离线节点</button>`;
  } else {
    const reasons = [...new Set(warnings.flatMap((target) => target.reasons))].join('、');
    els.banner.innerHTML = `
      <span class="banner-icon">${iconAlert()}</span>
      <div class="banner-copy">
        <strong>${warnings.length} 个节点处于注意状态</strong>
        <span>${escapeHtml(reasons || '指标接近阈值')} · 服务仍在正常响应</span>
      </div>
      <button class="banner-action" type="button" data-filter="warning">查看相关节点</button>`;
  }
}

function renderKpis(overview) {
  const { summary, targets } = overview;
  const regions = new Set(targets.map((target) => target.country || target.group).filter(Boolean)).size;
  els.kpiTotal.textContent = summary.total;
  els.kpiTotalFoot.textContent = `覆盖 ${regions} 个地区 · ${summary.pending} 个待探测`;
  els.kpiOnline.textContent = summary.online;
  els.kpiTotal2.textContent = summary.total;
  els.kpiOnlineFoot.textContent = summary.offline
    ? `${summary.offline} 个离线 · ${summary.warning} 个注意`
    : (summary.warning ? `${summary.warning} 个节点需要注意` : '全部节点运行正常');
  const onlineRatio = summary.total ? (summary.online / summary.total) * 100 : 0;
  els.kpiOnlineBar.style.width = `${Math.min(100, onlineRatio)}%`;
  els.kpiLatency.textContent = summary.avgLatency == null ? '—' : formatLatency(summary.avgLatency);
  els.kpiLatencyFoot.textContent = summary.checks30d
    ? `基于 ${formatNumber(summary.checks30d)} 次探测`
    : '等待探测数据';

  const dots = targets.map((target) => `<i class="${target.status}" title="${escapeHtml(target.name)}"></i>`).join('');
  els.kpiDots.innerHTML = dots;

  const latencies = targets.map((target) => target.latencyMs).filter((value) => Number.isFinite(value));
  const maxLatency = Math.max(...latencies, 1);
  const bars = [...latencies].sort((a, b) => a - b).slice(-16);
  els.kpiLatencyBars.innerHTML = bars
    .map((value) => `<i style="height:${Math.max(18, (value / maxLatency) * 100)}%"></i>`)
    .join('');

  els.kpiAvailability.textContent = formatPercent(summary.availability30d);
  els.kpiAvailabilityFoot.textContent = summary.checks30d
    ? `累计 ${formatNumber(summary.checks30d)} 次检查`
    : '尚无检查记录';
  const circumference = 2 * Math.PI * 18;
  const ratio = summary.availability30d == null ? 0 : summary.availability30d / 100;
  els.kpiRing.style.strokeDasharray = `${circumference}`;
  els.kpiRing.style.strokeDashoffset = `${circumference * (1 - ratio)}`;
}

function renderFilters(overview) {
  const counts = { all: overview.summary.total };
  for (const target of overview.targets) counts[target.status] = (counts[target.status] || 0) + 1;
  const options = [
    ['all', '全部'],
    ['online', '正常'],
    ['warning', '注意'],
    ['offline', '离线'],
    ['pending', '待探测'],
  ];
  els.filters.innerHTML = options
    .filter(([key]) => key === 'all' || counts[key])
    .map(([key, label]) => `<button type="button" data-filter="${key}" role="tab" aria-selected="${state.filter === key}" class="${state.filter === key ? 'is-active' : ''}">${label}<b>${counts[key] || 0}</b></button>`)
    .join('');
}

function nodeMatches(target) {
  if (state.filter !== 'all' && target.status !== state.filter) return false;
  if (!state.search) return true;
  const needle = state.search.toLowerCase();
  return [target.name, target.group, target.city, target.country, target.type, ...(target.tags || [])]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function renderNodes() {
  const overview = state.overview;
  if (!overview) return;
  const nodes = overview.targets
    .filter(nodeMatches)
    .sort((a, b) => (STATE_ORDER[a.status] ?? 9) - (STATE_ORDER[b.status] ?? 9));

  els.grid.innerHTML = nodes.map(nodeCard).join('');
  els.empty.hidden = nodes.length > 0;
  els.nodesNote.textContent = overview.targets.length
    ? `共 ${overview.targets.length} 个节点 · 最后探测 ${formatRelative(overview.summary.lastUpdated)} · 每 5 秒同步`
    : '还没有配置节点，编辑 config.json 后重启即可。';

  for (const card of $$('.node-card', els.grid)) {
    const target = overview.targets.find((node) => node.id === card.dataset.id);
    if (!target) continue;
    const spark = $('.spark', card);
    if (spark) spark.innerHTML = sparkline(target.sparkline, { accent: accentColor(state.prefs) });
  }
}

function nodeCard(target) {
  const status = target.status;
  const latency = target.latencyMs;
  const availability = target.availability30d;
  const third = thirdStat(target);
  const reasonText = status === 'offline'
    ? (target.error || '节点当前不可达')
    : (target.reasons || []).join('、');
  const typeLabel = TYPE_LABEL[target.type] || target.type;
  const metaParts = [target.city || target.group || '未知地区', typeLabel, ...(target.tags || []).slice(0, 1)];
  const daily = (target.daily || []).map((day) => {
    const label = `${day.date} · ${day.availability == null ? '无数据' : `${day.availability}%`}${day.total ? ` · ${formatNumber(day.total)} 次检查` : ''}`;
    return `<i class="${day.level}" title="${escapeHtml(label)}"></i>`;
  }).join('');

  const meters = target.type === 'agent' && target.metrics ? `
    <div class="meters">
      ${meterRow('CPU', target.metrics.cpu, 80)}
      ${meterRow('MEM', target.metrics.mem, 85)}
      ${meterRow('DISK', target.metrics.disk, 90)}
    </div>` : '';

  const note = (status === 'offline' || status === 'warning') && reasonText
    ? `<div class="node-note" title="${escapeHtml(reasonText)}">${escapeHtml(reasonText)}</div>`
    : '';

  return `
  <article class="node-card" data-id="${escapeHtml(target.id)}" data-status="${status}" tabindex="0" role="button" aria-label="${escapeHtml(target.name)}，${STATUS_LABEL[status] || status}">
    <header class="node-head">
      <div class="node-identity">
        <span class="node-flag">${escapeHtml(target.country || '··')}</span>
        <div class="node-title">
          <h3>${escapeHtml(target.name)}</h3>
          <p>${metaParts.map((part) => `<span>${escapeHtml(part)}</span>`).join('<i>·</i>')}</p>
        </div>
      </div>
      ${statusPill(status)}
    </header>
    <div class="node-stats">
      <div class="stat">
        <span>延迟</span>
        <strong class="${latency == null ? 'is-muted' : (status === 'offline' ? 'is-offline' : '')}">${latency == null ? '—' : `${formatLatency(latency)}<em>ms</em>`}</strong>
      </div>
      <div class="stat">
        <span>30 天可用率</span>
        <strong class="${availability == null ? 'is-muted' : ''}">${availability == null ? '—' : `${formatPercent(availability)}<em>%</em>`}</strong>
      </div>
      <div class="stat">
        <span>${third.label}</span>
        <strong class="${third.className}">${third.html}</strong>
      </div>
    </div>
    <div class="spark"></div>
    <div class="daily">
      <div class="daily-meta"><span>最近 30 天</span><b>${availability == null ? '—' : `${formatPercent(availability)}%`}</b></div>
      <div class="daily-bars">${daily}</div>
    </div>
    ${meters}
    ${note}
    <footer class="node-foot">
      <span class="endpoint" title="${escapeHtml(target.endpoint)}">${escapeHtml(target.endpoint)}</span>
      <span class="last-seen">${relativePillAgo(target.lastCheck)}</span>
    </footer>
  </article>`;
}

function thirdStat(target) {
  if (target.status === 'offline') {
    return { label: '离线时长', html: formatShortUptime(target.since), className: 'is-offline' };
  }
  if (target.status === 'pending') {
    return { label: '状态', html: '等待数据', className: 'is-muted' };
  }
  if (target.type === 'agent') {
    const cpu = target.metrics?.cpu;
    return {
      label: 'CPU',
      html: cpu == null ? '—' : `${formatLatency(cpu)}<em>%</em>`,
      className: cpu != null && cpu >= 80 ? 'is-warning' : (cpu == null ? 'is-muted' : ''),
    };
  }
  if (target.type === 'https' || target.type === 'http') {
    const days = target.tls?.daysLeft;
    if (target.type === 'https' && days != null) {
      return {
        label: '证书剩余',
        html: `${Math.max(0, Math.round(days))}<em>天</em>`,
        className: days <= 14 ? 'is-warning' : (days < 0 ? 'is-offline' : ''),
      };
    }
    return { label: '检查间隔', html: `${target.intervalSeconds}<em>秒</em>`, className: '' };
  }
  return { label: '持续在线', html: `${formatShortUptime(target.since)}`, className: '' };
}

function meterRow(label, value, warnAt) {
  const percent = value == null ? 0 : Math.max(0, Math.min(100, value));
  return `<div class="meter ${value != null && value >= warnAt ? 'is-warn' : ''}">
    <span>${label}</span>
    <div class="meter-track"><span style="width:${percent}%"></span></div>
    <span class="meter-value">${value == null ? '—' : `${percent.toFixed(0)}%`}</span>
  </div>`;
}

function renderIncidents() {
  const incidents = state.incidents || [];
  if (!incidents.length) {
    els.incidentList.innerHTML = '<li class="incident-empty">最近没有故障记录。所有节点运行平稳。</li>';
    els.incidentMeta.textContent = '最近 0 条';
    return;
  }
  const ongoing = incidents.filter((incident) => incident.ongoing).length;
  els.incidentMeta.textContent = ongoing ? `进行中 ${ongoing} · 共 ${incidents.length} 条` : `最近 ${incidents.length} 条`;
  els.incidentList.innerHTML = incidents.slice(0, 8).map((incident) => {
    const started = new Date(incident.startedAt);
    const pad = (value) => String(value).padStart(2, '0');
    const dotClass = incident.ongoing ? 'ongoing' : '';
    const date = `${pad(started.getMonth() + 1)}-${pad(started.getDate())}`;
    const time = `${pad(started.getHours())}:${pad(started.getMinutes())}`;
    return `<li class="incident-item" data-target="${escapeHtml(incident.targetId)}">
      <div class="incident-rail"><span class="incident-dot ${dotClass}"></span></div>
      <div class="incident-main">
        <strong>${escapeHtml(incident.targetName)} ${incident.ongoing ? '<em>进行中</em>' : ''}</strong>
        <p>${escapeHtml(incident.error)} · <span>持续 ${formatDuration(incident.durationMs)}</span></p>
      </div>
      <div class="incident-time"><b>${time}</b>${date}</div>
    </li>`;
  }).join('');
}

function renderInfoPanel(overview) {
  if (!els.infoNodes) return;
  const user = state.auth?.user;
  els.infoNodes.textContent = `${overview.summary.total} 个`;
  els.infoChecks.textContent = formatNumber(overview.summary.checks30d);
  els.infoHistory.textContent = `${overview.site.historyDays || 35} 天`;
  els.infoUser.textContent = user
    ? `${user.displayName} · ${user.role === 'admin' ? '管理员' : '成员'}`
    : (state.auth?.required ? '需要登录' : '访客');
  els.infoSync.textContent = formatRelative(overview.summary.lastUpdated);
  els.infoVersion.textContent = `v${overview.version || '1.2.0'}`;
}

// ------------------------------------------------------------------ drawer

function openDrawer(id) {
  state.selectedId = id;
  state.range = '24h';
  state.lastFocus = document.activeElement;
  clearTimeout(drawerHideTimer);
  els.drawer.hidden = false;
  els.drawerBackdrop.hidden = false;
  requestAnimationFrame(() => {
    els.drawer.classList.add('is-open');
    els.drawerBackdrop.classList.add('is-open');
    document.body.classList.add('drawer-open');
    els.drawer.setAttribute('aria-hidden', 'false');
  });
  if (globe) globe.setSelected(id);
  els.drawerContent.innerHTML = skeletonDrawer();
  loadDetail(false);
  setTimeout(() => $('.drawer-close', els.drawerContent)?.focus({ preventScroll: true }), 420);
}

function closeDrawer() {
  if (!state.selectedId) return;
  state.selectedId = null;
  state.detail = null;
  state.chart?.destroy();
  state.metricChart?.destroy();
  state.chart = null;
  state.metricChart = null;
  els.drawer.classList.remove('is-open');
  els.drawerBackdrop.classList.remove('is-open');
  els.drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  if (globe) globe.setSelected(null);
  clearTimeout(drawerHideTimer);
  drawerHideTimer = setTimeout(() => {
    if (state.selectedId) return;
    els.drawer.hidden = true;
    els.drawerBackdrop.hidden = true;
    els.drawerContent.innerHTML = '';
  }, 400);
  state.lastFocus?.focus?.({ preventScroll: true });
}

function skeletonDrawer() {
  return `<div class="drawer-head"><div class="skeleton-line" style="width:60%;height:22px"></div><div class="skeleton-line short"></div></div>
    <div class="drawer-body"><div class="drawer-skeleton">
      <div class="skeleton-line" style="width:80%"></div>
      <div class="skeleton-line tall"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line short"></div>
    </div></div>`;
}

async function loadDetail(silent = true) {
  const id = state.selectedId;
  if (!id) return;
  const seq = ++detailSeq;
  try {
    const detail = await api(`/api/targets/${encodeURIComponent(id)}?range=${state.range}`);
    if (seq !== detailSeq || state.selectedId !== id) return;
    state.detail = detail;
    renderDrawer(detail, silent);
  } catch (error) {
    if (error.loginRequired) return showAuthGate();
    if (!silent) {
      els.drawerContent.innerHTML = `<div class="drawer-head"><button class="drawer-close" type="button" data-action="close">×</button></div><div class="drawer-body"><p class="incident-empty">加载失败：${escapeHtml(error.message)}</p></div>`;
      bindDrawer();
    }
    toast(error.message);
  }
}

function renderDrawer(detail, preserveScroll = true) {
  const target = detail.target;
  const previousScroll = preserveScroll ? els.drawerContent.scrollTop || 0 : 0;
  state.chart?.destroy();
  state.metricChart?.destroy();
  state.chart = null;
  state.metricChart = null;

  const typeLabel = TYPE_LABEL[target.type] || target.type;
  const summary = detail.summary;
  const tabs = ['1h', '24h', '7d', '30d']
    .map((range) => `<button type="button" data-range="${range}" class="${state.range === range ? 'is-active' : ''}">${range}</button>`)
    .join('');

  const metricsSection = target.type === 'agent' && detail.metrics ? `
    <section class="drawer-section">
      <div class="section-row"><h3>系统负载</h3><span class="hint">Agent 实时上报</span></div>
      <div class="drawer-meters">
        ${drawerMeter('CPU', detail.metrics.cpu, 80)}
        ${drawerMeter('内存', detail.metrics.mem, 85)}
        ${drawerMeter('磁盘', detail.metrics.disk, 90)}
      </div>
      <div class="chart-wrap" style="height:150px;margin-top:14px">
        <canvas id="metric-chart"></canvas>
        <div class="chart-tooltip" id="metric-tooltip"></div>
      </div>
      <div class="chart-legend"><span><i style="background:#ffb85c"></i>CPU 使用率</span><span>${detail.range} 平均</span></div>
      <div class="agent-grid">
        <div class="agent-cell"><span>主机名</span><strong>${escapeHtml(detail.agent?.hostname || '—')}</strong></div>
        <div class="agent-cell"><span>系统</span><strong>${escapeHtml(detail.agent?.platform || '—')}</strong></div>
        <div class="agent-cell"><span>内核</span><strong>${escapeHtml(detail.agent?.kernel || '—')}</strong></div>
        <div class="agent-cell"><span>CPU 核心</span><strong>${detail.agent?.cores ? `${detail.agent.cores} vCPU` : '—'}</strong></div>
        <div class="agent-cell"><span>运行时长</span><strong>${formatUptimeSeconds(detail.agent?.uptimeSeconds)}</strong></div>
        <div class="agent-cell"><span>负载 (1/5/15)</span><strong>${Array.isArray(detail.metrics.load) ? detail.metrics.load.map((value) => Number(value).toFixed(2)).join(' / ') : '—'}</strong></div>
        <div class="agent-cell"><span>入站速率</span><strong>${formatMbps(detail.metrics.net?.rxRate)}</strong></div>
        <div class="agent-cell"><span>出站速率</span><strong>${formatMbps(detail.metrics.net?.txRate)}</strong></div>
        <div class="agent-cell"><span>累计流量</span><strong>${formatBytes(detail.metrics.net?.rxBytes)} ↓ / ${formatBytes(detail.metrics.net?.txBytes)} ↑</strong></div>
        <div class="agent-cell"><span>最近上报</span><strong>${formatRelative(detail.agent?.lastSeen)}</strong></div>
      </div>
    </section>` : '';

  const tlsSection = target.tls ? `
    <section class="drawer-section">
      <div class="section-row"><h3>TLS 证书</h3><span class="hint">${escapeHtml(target.tls.protocol || '')}</span></div>
      <div class="tls-card">
        <div class="tls-days">
          <strong style="${target.tls.daysLeft <= 14 ? 'color:var(--amber)' : ''}">${target.tls.daysLeft == null ? '—' : Math.max(0, Math.round(target.tls.daysLeft))}</strong>
          <span>天后续期</span>
        </div>
        <div class="tls-meta">
          签发者 <b>${escapeHtml(target.tls.issuer || '—')}</b><br>
          有效期至 <b>${target.tls.validTo ? new Date(target.tls.validTo).toLocaleDateString('zh-CN') : '—'}</b><br>
          ${target.tls.authorized ? '证书链验证通过' : '证书链验证失败'}
        </div>
      </div>
    </section>` : '';

  const servicesSection = detail.services?.length ? `
    <section class="drawer-section">
      <div class="section-row"><h3>服务检查</h3><span class="hint">${detail.services.filter((service) => service.active).length}/${detail.services.length} 运行中</span></div>
      <div class="service-chips">
        ${detail.services.map((service) => `<span class="service-chip ${service.active ? '' : 'is-off'}"><i></i>${escapeHtml(service.name)}</span>`).join('')}
      </div>
    </section>` : '';

  const incidentsSection = `
    <section class="drawer-section">
      <div class="section-row"><h3>历史事件</h3><span class="hint">${detail.incidents.length} 条</span></div>
      ${detail.incidents.length ? `<div class="drawer-incidents">
        ${detail.incidents.map((incident) => `<div class="drawer-incident ${incident.ongoing ? '' : 'is-resolved'}">
          <i></i>
          <div>
            <strong>${escapeHtml(incident.error || '探测失败')}</strong>
            <span>${new Date(incident.startedAt).toLocaleString('zh-CN', { hour12: false })} · ${incident.ongoing ? '进行中' : `持续 ${formatDuration(incident.durationMs)}`}</span>
          </div>
        </div>`).join('')}
      </div>` : '<p style="font-size:11.5px;color:var(--text-3);margin:0">该节点近期没有异常记录。</p>'}
    </section>`;

  const tags = target.tags?.length
    ? `<div class="service-chips" style="margin-top:8px">${target.tags.map((tag) => `<span class="service-chip"><i></i>${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';

  els.drawerContent.innerHTML = `
    <div class="drawer-head">
      <div class="drawer-head-main">
        <span class="node-flag big">${escapeHtml(target.country || '··')}</span>
        <div>
          <p class="drawer-kicker">${escapeHtml(target.city || target.group || '未知地区')} · ${typeLabel}</p>
          <h2>${escapeHtml(target.name)}</h2>
        </div>
      </div>
      <div class="drawer-head-actions">
        ${statusPill(target.status)}
        <button class="drawer-close" type="button" data-action="close" aria-label="关闭详情">
          <svg viewBox="0 0 20 20" fill="none"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
    <div class="drawer-body">
      <div class="drawer-summary">
        <div><span>区间可用率</span><strong>${summary.availability == null ? '—' : `${formatPercent(summary.availability)}<em>%</em>`}</strong></div>
        <div><span>平均延迟</span><strong>${summary.avgLatency == null ? '—' : `${formatLatency(summary.avgLatency)}<em>ms</em>`}</strong></div>
        <div><span>检查次数</span><strong>${formatNumber(summary.checks)}</strong></div>
      </div>

      <section class="drawer-section">
        <div class="section-row">
          <h3>延迟趋势</h3>
          <div class="range-tabs">${tabs}</div>
        </div>
        <div class="chart-wrap">
          <canvas id="latency-chart"></canvas>
          <div class="chart-tooltip" id="latency-tooltip"></div>
        </div>
        <div class="chart-legend">
          <span><i style="background:#34e6c6"></i>响应延迟</span>
          <span>最低 ${summary.minLatency == null ? '—' : `${formatLatency(summary.minLatency)} ms`}</span>
          <span>最高 ${summary.maxLatency == null ? '—' : `${formatLatency(summary.maxLatency)} ms`}</span>
        </div>
      </section>

      ${target.type === 'agent' ? metricsSection : tlsSection}
      ${servicesSection}
      ${incidentsSection}

      <section class="drawer-section">
        <div class="section-row"><h3>节点信息</h3><span class="hint">只读</span></div>
        ${tags}
        <div class="meta-rows" style="margin-top:8px">
          <div class="meta-row"><span>探测类型</span><b>${typeLabel}</b></div>
          <div class="meta-row"><span>探测地址</span><b title="${escapeHtml(target.endpoint)}">${escapeHtml(target.endpoint)}</b></div>
          <div class="meta-row"><span>探测间隔</span><b>${detail.config.intervalSeconds} 秒</b></div>
          <div class="meta-row"><span>超时阈值</span><b>${detail.config.timeoutMs} ms</b></div>
          <div class="meta-row"><span>最近成功</span><b>${formatRelative(target.lastOk)}</b></div>
          <div class="meta-row"><span>状态自</span><b>${target.since ? formatRelative(target.since) : '—'}</b></div>
          ${detail.note ? `<div class="meta-row"><span>备注</span><b>${escapeHtml(detail.note)}</b></div>` : ''}
        </div>
      </section>
    </div>`;

  bindDrawer();
  els.drawerContent.scrollTop = previousScroll;

  const latencyCanvas = $('#latency-chart', els.drawerContent);
  if (latencyCanvas) {
    state.chart = new TimeChart(latencyCanvas, $('#latency-tooltip', els.drawerContent));
    state.chart.setData({
      points: detail.points,
      range: detail.range,
      valueKey: 'latency',
      label: '延迟',
      unit: ' ms',
      color: accentColor(state.prefs),
    });
  }
  const metricCanvas = $('#metric-chart', els.drawerContent);
  if (metricCanvas) {
    state.metricChart = new TimeChart(metricCanvas, $('#metric-tooltip', els.drawerContent));
    state.metricChart.setData({
      points: detail.points,
      range: detail.range,
      valueKey: 'cpu',
      label: 'CPU',
      unit: '%',
      color: '#ffb85c',
    });
  }
}

function drawerMeter(label, value, warnAt) {
  const percent = value == null ? 0 : Math.max(0, Math.min(100, value));
  return `<div class="drawer-meter ${value != null && value >= warnAt ? 'meter is-warn' : 'meter'}" style="display:grid">
    <span>${label}</span>
    <div class="meter-track"><span style="width:${percent}%"></span></div>
    <span class="meter-value">${value == null ? '—' : `${percent.toFixed(1)}%`}</span>
  </div>`;
}

function bindDrawer() {
  $('.drawer-close', els.drawerContent)?.addEventListener('click', closeDrawer);
  $$('[data-range]', els.drawerContent).forEach((button) => {
    button.addEventListener('click', () => {
      if (state.range === button.dataset.range) return;
      state.range = button.dataset.range;
      $$('[data-range]', els.drawerContent).forEach((item) => item.classList.toggle('is-active', item === button));
      loadDetail(false);
    });
  });
}

// ------------------------------------------------------------------ globe setup

function setupGlobe() {
  const canvas = $('#globe');
  if (!canvas) return;
  globe = new Globe(canvas, {
    hub: { lat: 31.23, lon: 121.47, name: '探针中枢' },
    accent: accentColor(state.prefs),
    onSelect: (id) => openDrawer(id),
    onCoordChange: (lat, lon) => {
      if (!els.globeCoord) return;
      const latLabel = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
      const lonLabel = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
      els.globeCoord.innerHTML = `${latLabel}&nbsp;&nbsp;${lonLabel}`;
    },
  });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paused = !state.prefs.motion || reduceMotion;
  globe.setPaused(paused);
  els.globeToggle.innerHTML = paused ? iconPlay() : iconPause();
  els.globeToggle.setAttribute('aria-label', paused ? '继续旋转' : '暂停旋转');
  els.globeToggle.title = paused ? '继续旋转' : '暂停旋转';
}

// ------------------------------------------------------------------ polling

async function refreshOverview() {
  if (state.refreshing) return;
  state.refreshing = true;
  els.refresh.classList.add('is-spinning');
  try {
    const overview = await api('/api/overview');
    state.overview = overview;
    renderShell(overview);
    try {
      const incidents = await api('/api/incidents?limit=20');
      state.incidents = incidents.incidents || [];
      renderIncidents();
    } catch {
      // incidents are decorative; keep the page alive if this one fails
    }
    if (state.selectedId) loadDetail(true);
  } catch (error) {
    if (error.loginRequired) {
      stopPolling();
      return showAuthGate();
    }
    toast(`刷新失败：${error.message}`);
  } finally {
    state.refreshing = false;
    els.refresh.classList.remove('is-spinning');
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    refreshOverview();
  }, 5000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ------------------------------------------------------------------ appearance

const GUEST_AVATAR = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.5" r="3.1" stroke="currentColor" stroke-width="1.5"/><path d="M5.8 19.1c.8-3.1 3.3-4.9 6.2-4.9s5.4 1.8 6.2 4.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function initials(value) {
  const text = String(value || '').trim();
  if (!text) return '?';
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  if (/[\u3400-\u9fff]/.test(text)) return text.slice(0, 1);
  return text.slice(0, 2).toUpperCase();
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function syncAppearanceControls() {
  if (!els.appearancePopover) return;
  const prefs = state.prefs || DEFAULT_PREFERENCES;
  $$('[data-pref]', els.appearancePopover).forEach((button) => {
    button.classList.toggle('is-active', String(prefs[button.dataset.pref]) === button.dataset.value);
  });
  $$('[data-toggle]', els.appearancePopover).forEach((input) => {
    input.checked = Boolean(prefs[input.dataset.toggle]);
  });
  if (els.prefScope) {
    els.prefScope.textContent = state.auth?.user ? `保存到 @${state.auth.user.username}` : '偏好保存在本机';
  }
}

function setGlobeMotion(enabled) {
  if (!globe) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paused = !enabled || reduceMotion;
  globe.setPaused(paused);
  els.globeToggle.innerHTML = paused ? iconPlay() : iconPause();
  els.globeToggle.setAttribute('aria-label', paused ? '继续旋转' : '暂停旋转');
  els.globeToggle.title = paused ? '继续旋转' : '暂停旋转';
}

function applyAppearance(preferences, { persist = true, forceMotion = false } = {}) {
  const previousMotion = state.prefs?.motion;
  const next = normalizePreferences(preferences, state.prefs || DEFAULT_PREFERENCES);
  state.prefs = next;
  applyPreferences(next);
  if (persist) savePreferences(next);
  syncAppearanceControls();
  if (globe) {
    globe.setAccent(accentColor(next));
    if (forceMotion || previousMotion !== next.motion) setGlobeMotion(next.motion);
  }
  if (state.overview) renderNodes();
  if (state.selectedId) loadDetail(true);
}

function schedulePreferenceSync() {
  if (!state.auth?.user) return;
  clearTimeout(state.prefSaveTimer);
  state.prefSaveTimer = setTimeout(async () => {
    try {
      const result = await api('/api/account', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: state.prefs }),
      });
      if (result.user) state.auth.user = result.user;
    } catch (error) {
      if (error.loginRequired) return showAuthGate();
      toast(`外观偏好同步失败：${error.message}`);
    }
  }, 500);
}

function setPreference(key, value) {
  const next = { ...state.prefs, [key]: value };
  if (key === 'style') {
    const preset = STYLE_PRESETS[value];
    if (preset) next.accent = preset.accent;
  }
  applyAppearance(next);
  schedulePreferenceSync();
}

function closePopovers(except = null) {
  const pairs = [
    [els.appearancePopover, els.appearanceButton],
    [els.accountPopover, els.accountButton],
  ];
  for (const [popover, button] of pairs) {
    if (!popover || popover === except) continue;
    popover.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }
}

function togglePopover(popover, button) {
  if (!popover) return;
  const wasOpen = !popover.hidden;
  closePopovers(popover);
  popover.hidden = wasOpen;
  button?.setAttribute('aria-expanded', String(!wasOpen));
  return !wasOpen;
}

// ------------------------------------------------------------------ account ui

function updateAccountUI() {
  const user = state.auth?.user;
  if (!user) {
    els.accountAvatar.innerHTML = GUEST_AVATAR;
    els.accountAvatar.classList.add('guest');
    els.accountButton.classList.remove('is-authed');
    els.accountButton.title = '登录 / 账号';
    els.accountButton.setAttribute('aria-label', '登录或账号设置');
  } else {
    els.accountAvatar.textContent = initials(user.displayName || user.username);
    els.accountAvatar.classList.remove('guest');
    els.accountButton.classList.add('is-authed');
    els.accountButton.title = `${user.displayName} · @${user.username}`;
    els.accountButton.setAttribute('aria-label', `账号：${user.displayName}`);
  }
  syncAppearanceControls();
  if (state.overview) renderInfoPanel(state.overview);
}

function renderAccountPopover() {
  const auth = state.auth || { required: false, setupRequired: false, user: null, demoAccounts: [] };
  const user = auth.user;
  if (user) {
    els.accountPopoverBody.innerHTML = `
      <div class="account-head">
        <span class="account-avatar">${escapeHtml(initials(user.displayName || user.username))}</span>
        <div class="account-meta">
          <strong>${escapeHtml(user.displayName)}</strong>
          <span>@${escapeHtml(user.username)} · <span class="role-badge">${user.role === 'admin' ? 'ADMIN' : 'MEMBER'}</span></span>
        </div>
      </div>
      <div class="account-actions">
        <button type="button" data-account-action="settings">账号设置</button>
        ${user.role === 'admin' ? '<button type="button" data-account-action="admin">用户管理</button>' : ''}
        <button type="button" data-account-action="logout" class="danger">退出登录</button>
      </div>`;
    return;
  }
  const demo = auth.demo && auth.demoAccounts?.length
    ? `<div class="demo-hint">演示账号<br>${auth.demoAccounts.map((account) => `<b>${escapeHtml(account.username)}</b> / ${escapeHtml(account.password)} <span>(${account.role === 'admin' ? '管理员' : '成员'})</span>`).join('<br>')}</div>`
    : '';
  const actions = [];
  actions.push('<button type="button" class="button primary" data-account-action="login">登录</button>');
  if (auth.allowRegistration) actions.push('<button type="button" class="text-button" data-account-action="register">创建账号</button>');
  if (auth.setupRequired) actions.push('<button type="button" class="text-button" data-account-action="setup">初始化管理员</button>');
  els.accountPopoverBody.innerHTML = `
    <div class="account-head">
      <span class="account-avatar guest">?</span>
      <div class="account-meta">
        <strong>访客</strong>
        <span>${auth.required ? '此面板需要登录' : '未登录 · 公开浏览'}</span>
      </div>
    </div>
    <p class="account-note">${auth.required ? '账号由管理员创建。' : '登录后可保存外观偏好、管理账号；不影响匿名查看公开状态。'}</p>
    <div class="account-actions">${actions.join('')}</div>
    ${demo}`;
}

async function fetchAuthStatus() {
  const response = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取登录状态（${response.status}）`);
  return response.json();
}

function authField(name, label, type = 'text', options = {}) {
  const { placeholder = '', autocomplete = 'off', hint = '' } = options;
  return `<div class="form-field">
    <label for="auth-${name}">${label}</label>
    <input id="auth-${name}" name="${name}" type="${type}" autocomplete="${autocomplete}" placeholder="${escapeHtml(placeholder)}" />
    ${hint ? `<p class="form-hint">${hint}</p>` : ''}
  </div>`;
}

function openAuthModal(mode = 'login', { gate = false } = {}) {
  const auth = state.auth || {};
  if (auth.setupRequired && mode === 'login') mode = 'setup';
  state.authMode = mode;
  state.authGate = gate || Boolean(auth.required && !auth.user);
  const titles = {
    login: ['登录', '使用账号进入 Eleganza。'],
    setup: ['初始化管理员', '创建第一个管理员账号。'],
    register: ['创建账号', '注册一个成员账号。'],
  };
  els.authTitle.textContent = titles[mode]?.[0] || '登录';
  els.authSubtitle.textContent = titles[mode]?.[1] || '';
  const fields = [];
  if (mode === 'setup') {
    fields.push(authField('token', '初始化令牌', 'text', {
      placeholder: '服务器启动日志中的 setup token',
      hint: '首次启动时面板会在终端打印初始化令牌；也可以运行 <code>node tools/create-admin.mjs</code> 创建账号。',
    }));
  }
  if (mode !== 'login') {
    fields.push(authField('displayName', '显示名称', 'text', { placeholder: '例如：运营同学' }));
  }
  fields.push(authField('username', '用户名', 'text', {
    autocomplete: 'username',
    placeholder: '3–32 位字母、数字、点、下划线',
  }));
  fields.push(authField('password', '密码', 'password', {
    autocomplete: mode === 'login' ? 'current-password' : 'new-password',
    placeholder: '至少 8 位',
  }));
  if (mode !== 'login') {
    fields.push(authField('confirm', '确认密码', 'password', { autocomplete: 'new-password', placeholder: '再输入一次' }));
  }
  if (mode === 'login' && state.auth?.demoAccounts?.length) {
    fields.push(`<div class="demo-hint">演示账号<br>${state.auth.demoAccounts.map((account) => `<b>${escapeHtml(account.username)}</b> / ${escapeHtml(account.password)}`).join('<br>')}</div>`);
  }
  els.authFields.innerHTML = fields.join('');
  els.authError.hidden = true;
  els.authSubmit.textContent = mode === 'setup' ? '创建并登录' : (mode === 'register' ? '创建账号' : '登录');
  els.authSubmit.disabled = false;
  els.authModal.hidden = false;
  els.authModal.classList.toggle('is-gate', state.authGate);
  els.authClose.hidden = state.authGate;
  document.body.classList.add('modal-open');

  const links = [];
  if (mode === 'login') {
    if (state.auth?.allowRegistration) links.push(['register', '还没有账号？注册']);
    if (state.auth?.setupRequired) links.push(['setup', '首次使用？初始化管理员']);
  } else if (!state.auth?.setupRequired) {
    links.push(['login', '已有账号？登录']);
  }
  els.authAlt.innerHTML = links.map(([nextMode, label]) => `<button type="button" data-auth-mode="${nextMode}">${label}</button>`).join('');
  setTimeout(() => {
    const first = els.authFields.querySelector('input');
    first?.focus({ preventScroll: true });
  }, 100);
}

function closeAuthModal(force = false) {
  if (!force && (state.authGate || (state.auth?.required && !state.auth?.user))) return;
  els.authModal.hidden = true;
  els.authModal.classList.remove('is-gate');
  state.authGate = false;
  document.body.classList.remove('modal-open');
}

function showAuthGate() {
  stopPolling();
  if (!state.auth) {
    state.auth = { required: true, setupRequired: false, allowRegistration: false, user: null, demoAccounts: [] };
  }
  updateAccountUI();
  openAuthModal(state.auth.setupRequired ? 'setup' : 'login', { gate: true });
}

async function submitAuthForm(event) {
  event.preventDefault();
  const wasGated = state.authGate;
  const data = new FormData(els.authForm);
  const mode = state.authMode;
  const password = String(data.get('password') || '');
  const confirm = String(data.get('confirm') || '');
  if (mode !== 'login' && password !== confirm) {
    els.authError.textContent = '两次输入的密码不一致';
    els.authError.hidden = false;
    return;
  }
  if (mode !== 'login' && password.length < 8) {
    els.authError.textContent = '密码至少需要 8 位';
    els.authError.hidden = false;
    return;
  }
  const endpoints = {
    login: '/api/auth/login',
    setup: '/api/auth/setup',
    register: '/api/auth/register',
  };
  const payload = {
    username: String(data.get('username') || '').trim(),
    password,
    displayName: String(data.get('displayName') || '').trim(),
    token: String(data.get('token') || '').trim(),
  };
  els.authError.hidden = true;
  els.authSubmit.disabled = true;
  const original = els.authSubmit.textContent;
  els.authSubmit.textContent = '请稍候…';
  try {
    const response = await fetch(endpoints[mode], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '操作失败');
    state.auth = {
      ...state.auth,
      user: result.user,
      setupRequired: false,
      required: result.required ?? state.auth.required,
    };
    state.authGate = false;
    els.authModal.hidden = true;
    els.authModal.classList.remove('is-gate');
    document.body.classList.remove('modal-open');
    updateAccountUI();
    if (result.user?.preferences) {
      applyAppearance(result.user.preferences, { persist: true, forceMotion: true });
    }
    toast(`欢迎，${result.user?.displayName || result.user?.username || ''}`);
    closePopovers();
    if (!state.booted || wasGated) {
      state.booted = true;
      await refreshOverview();
      startPolling();
    } else {
      await refreshOverview();
    }
  } catch (error) {
    els.authError.textContent = error.message;
    els.authError.hidden = false;
  } finally {
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = original;
  }
}

async function handleLogout() {
  closePopovers();
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // ignore; the cookie is cleared server-side when possible
  }
  state.auth = { ...(state.auth || {}), user: null };
  updateAccountUI();
  if (state.auth.required) {
    stopPolling();
    showAuthGate();
  } else {
    toast('已退出登录');
    if (state.booted) refreshOverview();
  }
}

// ------------------------------------------------------------------ dialogs

function openDialog({ kicker = 'ACCOUNT', title, subtitle = '', body }) {
  els.dialogKicker.textContent = kicker;
  els.dialogTitle.textContent = title;
  els.dialogSubtitle.textContent = subtitle;
  els.dialogBody.innerHTML = body;
  els.dialogModal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeDialog() {
  els.dialogModal.hidden = true;
  els.dialogBody.innerHTML = '';
  if (els.authModal.hidden) document.body.classList.remove('modal-open');
}

function panelBaseUrl() {
  const configured = state.overview?.site?.publicUrl;
  try {
    const parsed = new URL(configured || location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  } catch {
    // Fall through to the address currently serving the panel.
  }
  return location.origin;
}

function openProbeCommandDialog() {
  const base = panelBaseUrl();
  const fromConfig = Boolean(state.overview?.site?.publicUrl);
  const fallbackNote = fromConfig
    ? ''
    : '<p class="probe-footnote">当前使用浏览器访问地址。如果这是 127.0.0.1 或 SSH 隧道地址，请在 config.json 中把 <code>site.publicUrl</code> 设置为对外域名。</p>';
  const command = `curl -fsSL https://raw.githubusercontent.com/TCNNM/eleganza/main/agent/install-agent.sh \\
  | sudo env ELEGANZA_SERVICES="nginx xray" ELEGANZA_MOUNTS="/ /var" \\
    bash -s -- '${base}' '<AGENT_TOKEN>'`;

  openDialog({
    kicker: 'AGENT INSTALL',
    title: '探针快捷安装',
    subtitle: `当前站点：${base}`,
    body: `
      <div class="dialog-section">
        <p class="dialog-lead">在目标服务器的 SSH 中执行下面命令。脚本会自动下载 Agent、写入 systemd 服务并启动。</p>
        <div class="info-cell probe-site-cell">
          <span>当前绑定站点${fromConfig ? ' · site.publicUrl' : ' · 当前访问地址'}</span>
          <strong>${escapeHtml(base)}</strong>
        </div>
        <div class="code-block">
          <div class="code-head">
            <span>AGENT INSTALL · SYSTEMD</span>
            <button class="copy-button" type="button" data-copy-target="probe-command-code" data-label="复制命令">复制命令</button>
          </div>
          <pre id="probe-command-code" tabindex="0">${escapeHtml(command)}</pre>
        </div>
      </div>
      <div class="dialog-section">
        <h3>执行前</h3>
        <ol class="probe-steps">
          <li>先在面板的 <code>config.json</code> 中为这台服务器添加 <code>type: "agent"</code> 节点。</li>
          <li>把命令中的 <code>&lt;AGENT_TOKEN&gt;</code> 替换成该节点的 <code>agentKey</code>。</li>
          <li>目标服务器需要能访问 <code>${escapeHtml(base)}</code>，并装有 curl 或 wget。</li>
        </ol>
        <p class="probe-footnote">每台服务器使用独立的 agentKey。安装完成后用 <code>journalctl -u eleganza-agent -f</code> 查看日志。</p>
        ${fallbackNote}
        <a class="panel-link" href="https://github.com/TCNNM/eleganza#agent" target="_blank" rel="noreferrer">
          查看完整 Agent 安装说明
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 4h9v9M16 4 6 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
      </div>`,
  });
}

function dialogError(container, message) {
  let box = container.querySelector('.form-error');
  if (!box) {
    box = document.createElement('p');
    box.className = 'form-error';
    container.prepend(box);
  }
  box.textContent = message;
  box.hidden = false;
}

function renderAccountSettings() {
  const user = state.auth?.user;
  if (!user) return;
  openDialog({
    kicker: 'ACCOUNT',
    title: '账号设置',
    subtitle: '修改显示名称或密码，外观偏好在右上角调色板中设置。',
    body: `
      <div class="dialog-section">
        <div class="dialog-grid">
          <div class="info-cell"><span>用户名</span><strong>@${escapeHtml(user.username)}</strong></div>
          <div class="info-cell"><span>角色</span><strong>${user.role === 'admin' ? '管理员' : '成员'}</strong></div>
          <div class="info-cell"><span>创建时间</span><strong>${formatDate(user.createdAt)}</strong></div>
          <div class="info-cell"><span>最近登录</span><strong>${formatDate(user.lastLoginAt)}</strong></div>
        </div>
      </div>
      <div class="dialog-section">
        <h3>显示名称</h3>
        <form id="profile-form">
          <div class="form-field">
            <label for="profile-display-name">显示名称</label>
            <input id="profile-display-name" name="displayName" maxlength="40" value="${escapeHtml(user.displayName)}" />
          </div>
          <div class="dialog-actions"><button class="button primary" type="submit">保存资料</button></div>
        </form>
      </div>
      <div class="dialog-section">
        <h3>修改密码</h3>
        <form id="password-form">
          <div class="form-field"><label for="current-password">当前密码</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" /></div>
          <div class="form-field"><label for="new-password">新密码</label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" placeholder="至少 8 位" /></div>
          <div class="form-field"><label for="confirm-password">确认新密码</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" /></div>
          <div class="dialog-actions"><button class="button primary" type="submit">更新密码</button></div>
        </form>
      </div>`,
  });

  const profileForm = $('#profile-form', els.dialogBody);
  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = profileForm.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/account', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: new FormData(profileForm).get('displayName') }),
      });
      state.auth.user = result.user;
      updateAccountUI();
      toast('资料已保存');
    } catch (error) {
      dialogError(profileForm, error.message);
    } finally {
      button.disabled = false;
    }
  });

  const passwordForm = $('#password-form', els.dialogBody);
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(passwordForm);
    if (data.get('newPassword') !== data.get('confirmPassword')) {
      dialogError(passwordForm, '两次输入的新密码不一致');
      return;
    }
    const button = passwordForm.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/account', {
        method: 'PATCH',
        body: JSON.stringify({
          currentPassword: data.get('currentPassword'),
          newPassword: data.get('newPassword'),
        }),
      });
      state.auth.user = result.user;
      updateAccountUI();
      closeDialog();
      toast('密码已更新，其他设备已退出登录');
    } catch (error) {
      dialogError(passwordForm, error.message);
    } finally {
      button.disabled = false;
    }
  });
}

async function loadAdminUsers() {
  const data = await api('/api/admin/users');
  const users = data.users || [];
  const rows = users.map((user) => {
    const isSelf = user.id === state.auth?.user?.id;
    return `<div class="user-row ${user.disabled ? 'is-disabled' : ''}">
      <span class="account-avatar">${escapeHtml(initials(user.displayName || user.username))}</span>
      <div class="user-meta">
        <strong>${escapeHtml(user.displayName)} ${user.role === 'admin' ? '<span class="role-badge">ADMIN</span>' : ''} ${user.disabled ? '<em>已禁用</em>' : ''}</strong>
        <span>@${escapeHtml(user.username)} · 最近登录 ${formatDate(user.lastLoginAt)}${isSelf ? ' · 当前账号' : ''}</span>
      </div>
      <div class="user-actions">
        <button class="chip-button" type="button" data-user-action="role" data-user-id="${escapeHtml(user.id)}" data-role="${user.role}" ${isSelf ? 'disabled' : ''}>${user.role === 'admin' ? '设为成员' : '设为管理员'}</button>
        <button class="chip-button" type="button" data-user-action="toggle" data-user-id="${escapeHtml(user.id)}" data-disabled="${user.disabled}" ${isSelf ? 'disabled' : ''}>${user.disabled ? '启用' : '禁用'}</button>
        <button class="chip-button" type="button" data-user-action="reset" data-user-id="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}" ${isSelf ? 'disabled' : ''}>重置密码</button>
        <button class="chip-button danger" type="button" data-user-action="delete" data-user-id="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}" ${isSelf ? 'disabled' : ''}>删除</button>
      </div>
    </div>`;
  }).join('');
  els.dialogBody.innerHTML = `
    <div class="dialog-section">
      <div class="users-toolbar"><span>${users.length} 个账号</span><span>管理员可创建、禁用或重置账号</span></div>
      <div class="user-list">${rows || '<div class="admin-empty">还没有账号。</div>'}</div>
      <form class="add-user" id="add-user-form">
        <h4>添加账号</h4>
        <div class="dialog-grid">
          <div class="form-field"><label for="new-username">用户名</label><input id="new-username" name="username" placeholder="3–32 位" /></div>
          <div class="form-field"><label for="new-display">显示名称</label><input id="new-display" name="displayName" placeholder="可选" /></div>
          <div class="form-field"><label for="new-user-password">初始密码</label><input id="new-user-password" name="password" type="password" placeholder="至少 8 位" /></div>
          <div class="form-field"><label for="new-role">角色</label><select id="new-role" name="role"><option value="member">成员</option><option value="admin">管理员</option></select></div>
        </div>
        <button class="button primary" type="submit">创建账号</button>
      </form>
    </div>`;

  const addForm = $('#add-user-form', els.dialogBody);
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(addForm));
    const button = addForm.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) });
      toast(`已创建 @${payload.username}`);
      await loadAdminUsers();
    } catch (error) {
      dialogError(addForm, error.message);
    } finally {
      button.disabled = false;
    }
  });

  els.dialogBody.onclick = async (event) => {
    const button = event.target.closest('[data-user-action]');
    if (!button) return;
    const { userAction, userId, username } = button.dataset;
    if (button.disabled) return;
    try {
      if (userAction === 'role') {
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: button.dataset.role === 'admin' ? 'member' : 'admin' }),
        });
      } else if (userAction === 'toggle') {
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ disabled: button.dataset.disabled !== 'true' }),
        });
      } else if (userAction === 'reset') {
        const password = window.prompt(`为 @${username} 设置新密码（至少 8 位）`);
        if (!password) return;
        if (password.length < 8) return toast('密码至少需要 8 位');
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ password }),
        });
        toast(`已重置 @${username} 的密码`);
      } else if (userAction === 'delete') {
        if (!window.confirm(`确定删除 @${username}？该操作不可撤销。`)) return;
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        toast(`已删除 @${username}`);
      }
      await loadAdminUsers();
    } catch (error) {
      if (error.loginRequired) return showAuthGate();
      toast(error.message);
    }
  };
}

function openAdminUsers() {
  if (state.auth?.user?.role !== 'admin') return toast('需要管理员权限');
  openDialog({
    kicker: 'ADMIN',
    title: '用户管理',
    subtitle: '管理 Eleganza 的账号与角色。',
    body: '<div class="admin-empty">正在读取账号…</div>',
  });
  loadAdminUsers().catch((error) => {
    if (error.loginRequired) return showAuthGate();
    els.dialogBody.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    const auth = await fetchAuthStatus();
    state.auth = auth;
    if (auth.user?.preferences) {
      applyAppearance(auth.user.preferences, { persist: true, forceMotion: true });
    }
    updateAccountUI();
    if (auth.required && !auth.user) {
      showAuthGate();
      return;
    }
    if (state.booted) return;
    state.booted = true;
    await refreshOverview();
    startPolling();
  } catch (error) {
    toast(`初始化失败：${error.message}`);
  }
}

function init() {
  tickClock();
  setInterval(tickClock, 1000);
  state.prefs = loadPreferences();
  applyPreferences(state.prefs);
  syncAppearanceControls();
  setupGlobe();

  els.refresh.addEventListener('click', () => refreshOverview());
  els.probeCommandButton?.addEventListener('click', openProbeCommandDialog);

  els.appearanceButton.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePopover(els.appearancePopover, els.appearanceButton);
  });

  els.appearancePopover.addEventListener('click', (event) => {
    const pref = event.target.closest('[data-pref]');
    if (pref) {
      setPreference(pref.dataset.pref, pref.dataset.value);
      return;
    }
    if (event.target.closest('[data-close-popover]')) {
      closePopovers();
      return;
    }
    if (event.target.closest('#pref-reset')) {
      applyAppearance(DEFAULT_PREFERENCES, { forceMotion: true });
      schedulePreferenceSync();
    }
  });

  els.appearancePopover.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) setPreference(toggle.dataset.toggle, toggle.checked);
  });

  els.accountButton.addEventListener('click', (event) => {
    event.stopPropagation();
    renderAccountPopover();
    togglePopover(els.accountPopover, els.accountButton);
  });

  els.accountPopover.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-account-action]');
    if (!button) return;
    const action = button.dataset.accountAction;
    closePopovers();
    if (action === 'settings') renderAccountSettings();
    else if (action === 'admin') openAdminUsers();
    else if (action === 'logout') await handleLogout();
    else if (action === 'login' || action === 'register' || action === 'setup') {
      openAuthModal(action);
    }
  });

  els.authForm.addEventListener('submit', submitAuthForm);

  els.authAlt.addEventListener('click', (event) => {
    const button = event.target.closest('[data-auth-mode]');
    if (!button) return;
    openAuthModal(button.dataset.authMode, { gate: state.authGate });
  });

  els.authModal.addEventListener('click', (event) => {
    if (event.target.closest('[data-auth-close]')) closeAuthModal();
  });

  els.dialogModal.addEventListener('click', (event) => {
    if (event.target.closest('[data-dialog-close]')) closeDialog();
  });

  els.globeToggle.addEventListener('click', () => {
    if (!globe) return;
    const paused = globe.toggle();
    els.globeToggle.innerHTML = paused ? iconPlay() : iconPause();
    els.globeToggle.setAttribute('aria-label', paused ? '继续旋转' : '暂停旋转');
    els.globeToggle.title = paused ? '继续旋转' : '暂停旋转';
  });
  els.filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    renderFilters(state.overview);
    renderNodes();
  });
  els.banner.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    renderFilters(state.overview);
    renderNodes();
    $('#nodes').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  let searchTimer = null;
  els.search.addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = event.target.value.trim();
      renderNodes();
    }, 100);
  });
  els.grid.addEventListener('click', (event) => {
    const card = event.target.closest('.node-card');
    if (card) openDrawer(card.dataset.id);
  });
  els.grid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.node-card');
    if (!card) return;
    event.preventDefault();
    openDrawer(card.dataset.id);
  });
  els.incidentList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-target]');
    if (item) openDrawer(item.dataset.target);
  });
  els.drawerBackdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.authModal.hidden && !state.authGate) {
      closeAuthModal();
      return;
    }
    if (!els.dialogModal.hidden) {
      closeDialog();
      return;
    }
    closePopovers();
    if (state.selectedId) closeDrawer();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.popover') && !event.target.closest('#appearance-button') && !event.target.closest('#account-button')) {
      closePopovers();
    }
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-target]');
    if (!button) return;
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    const label = button.dataset.label || button.textContent;
    try {
      await copyText(target.textContent);
      button.textContent = '已复制';
      button.classList.add('is-done');
      setTimeout(() => {
        button.textContent = label;
        button.classList.remove('is-done');
      }, 1600);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      toast('复制失败，已选中命令，请按 Ctrl+C');
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.booted && !(state.auth?.required && !state.auth?.user)) refreshOverview();
  });

  boot();
}

init();
