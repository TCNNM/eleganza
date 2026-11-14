import { Globe } from './globe.js';
import { sparkline, TimeChart } from './charts.js';

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
};

const els = {
  clock: $('#clock'),
  refresh: $('#refresh-button'),
  logout: $('#logout-button'),
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
  restSnippet: $('#rest-snippet'),
  mcpSnippet: $('#mcp-snippet'),
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
  loginLayer: $('#login-layer'),
  loginForm: $('#login-form'),
  loginPassword: $('#login-password'),
  loginSubmit: $('#login-submit'),
  loginError: $('#login-error'),
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
  els.footerText.textContent = site.footer || 'Polaris';
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
  renderSnippets(overview);
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
    if (spark) spark.innerHTML = sparkline(target.sparkline);
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

function renderSnippets(overview) {
  const origin = location.origin;
  const sample = overview.targets[0]?.id || 'hk-core';
  els.restSnippet.textContent = `curl -s ${origin}/api/overview | jq\ncurl -s "${origin}/api/targets/${sample}?range=24h" | jq\ncurl -s "${origin}/api/incidents?limit=20" | jq`;
  const token = '<MCP_TOKEN>';
  els.mcpSnippet.textContent = JSON.stringify({
    mcpServers: {
      polaris: {
        type: 'http',
        url: `${origin}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
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
    if (error.loginRequired) return showLogin();
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
      color: '#34e6c6',
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
    onSelect: (id) => openDrawer(id),
    onCoordChange: (lat, lon) => {
      if (!els.globeCoord) return;
      const latLabel = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
      const lonLabel = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
      els.globeCoord.innerHTML = `${latLabel}&nbsp;&nbsp;${lonLabel}`;
    },
  });
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    globe.setPaused(true);
    els.globeToggle.innerHTML = iconPlay();
  }
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
    if (error.loginRequired) return showLogin();
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

// ------------------------------------------------------------------ login

function showLogin() {
  els.loginLayer.hidden = false;
  setTimeout(() => els.loginPassword?.focus(), 100);
}

async function handleLogin(event) {
  event.preventDefault();
  els.loginError.hidden = true;
  els.loginSubmit.disabled = true;
  els.loginSubmit.textContent = '验证中…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: els.loginPassword.value }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '登录失败');
    els.loginLayer.hidden = true;
    els.loginPassword.value = '';
    await boot();
  } catch (error) {
    els.loginError.textContent = error.message;
    els.loginError.hidden = false;
  } finally {
    els.loginSubmit.disabled = false;
    els.loginSubmit.textContent = '解锁面板';
  }
}

async function handleLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    location.reload();
  }
}

// ------------------------------------------------------------------ boot

async function boot() {
  const session = await fetch('/api/session').then((response) => response.json()).catch(() => ({ required: false, authenticated: true }));
  els.logout.hidden = !session.required;
  if (session.required && !session.authenticated) {
    showLogin();
    return;
  }
  if (state.booted) return;
  state.booted = true;
  if (!globe) setupGlobe();
  await refreshOverview();
  startPolling();
}

function init() {
  tickClock();
  setInterval(tickClock, 1000);
  setupGlobe();

  els.refresh.addEventListener('click', () => refreshOverview());
  els.logout.addEventListener('click', handleLogout);
  els.loginForm.addEventListener('submit', handleLogin);
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
    if (event.key === 'Escape' && state.selectedId) closeDrawer();
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-target]');
    if (!button) return;
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent);
      button.textContent = '已复制';
      button.classList.add('is-done');
      setTimeout(() => {
        button.textContent = '复制';
        button.classList.remove('is-done');
      }, 1600);
    } catch {
      toast('复制失败，请手动选择文本');
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.booted) refreshOverview();
  });

  boot().catch((error) => {
    toast(`初始化失败：${error.message}`);
    els.loginLayer.hidden = true;
  });
}

init();
