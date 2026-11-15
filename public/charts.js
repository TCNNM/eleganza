// Tiny chart toolkit: no dependencies, canvas for detail, SVG for cards.
const MONO = '10px "SFMono-Regular", "JetBrains Mono", Consolas, monospace';

let gradientSeq = 0;

function smoothPath(points) {
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const cx = ((x0 + x1) / 2).toFixed(2);
    d += ` C${cx},${y0.toFixed(2)} ${cx},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '');
  const int = parseInt(value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function colorFor(value, warn = 350, accent = '#34e6c6') {
  if (value == null) return 'rgba(148,163,184,.35)';
  if (value >= warn * 2) return '#ff617d';
  if (value >= warn) return '#ffb85c';
  return accent;
}

export function sparkline(samples, { warn = 350, accent = '#34e6c6' } = {}) {
  const width = 320;
  const height = 60;
  const padX = 2;
  const padTop = 8;
  const padBottom = 8;
  const usable = height - padTop - padBottom;
  const values = (samples || []).map((sample) => (sample.ok && Number.isFinite(sample.latency) ? sample.latency : null));
  const finite = values.filter((value) => value != null);
  if (!finite.length) {
    return '<div class="spark-empty">等待探测样本</div>';
  }
  const max = Math.max(...finite, 20);
  const sorted = [...finite].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const scaleMax = Math.max(max, p90 * 1.15);
  const stepX = (width - padX * 2) / Math.max(1, values.length - 1);
  const toY = (value) => padTop + usable - (value / scaleMax) * usable;
  const id = `sg${++gradientSeq}`;

  let line = '';
  let segment = [];
  const segments = [];
  const failures = [];
  values.forEach((value, index) => {
    if (value == null) {
      failures.push(index);
      if (segment.length) {
        segments.push(segment);
        segment = [];
      }
      return;
    }
    segment.push([padX + index * stepX, toY(value)]);
  });
  if (segment.length) segments.push(segment);
  for (const points of segments) line += smoothPath(points);

  const area = segments
    .map((points) => `${smoothPath(points)} L${points[points.length - 1][0].toFixed(2)},${height - padBottom} L${points[0][0].toFixed(2)},${height - padBottom} Z`)
    .join(' ');

  const ticks = failures
    .map((index) => {
      const x = padX + index * stepX;
      return `<line x1="${x.toFixed(1)}" y1="${height - padBottom - 5}" x2="${x.toFixed(1)}" y2="${height - padBottom + 2}" stroke="#ff617d" stroke-width="1" stroke-opacity=".75"/>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="近期延迟曲线">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${accent}" stop-opacity=".28"/>
        <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}" stroke="rgba(148,163,184,.12)" stroke-width="1"/>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${colorFor(finite[finite.length - 1], warn, accent)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    ${ticks}
  </svg>`;
}

export function formatAxisTime(ms, range) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  if (range === '1h' || range === '24h') return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatFullTime(ms, range) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  const base = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return range === '30d' ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : base;
}

export class TimeChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.hoverIndex = -1;
    this.width = 0;
    this.height = 0;
    this.padding = { left: 42, right: 26, top: 14, bottom: 24 };
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
  }

  setData(payload) {
    this.data = {
      valueKey: 'latency',
      label: '延迟',
      unit: ' ms',
      color: '#34e6c6',
      ...payload,
    };
    this.hoverIndex = -1;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  points() {
    return this.data?.points || [];
  }

  xFor(index) {
    const { left, right } = this.padding;
    const points = this.points();
    if (points.length <= 1) return left;
    return left + (index / (points.length - 1)) * (this.width - left - right);
  }

  yFor(value, max) {
    const { top, bottom } = this.padding;
    const usable = this.height - top - bottom;
    return top + usable - (value / max) * usable;
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.width) return;
    ctx.clearRect(0, 0, this.width, this.height);
    const styles = getComputedStyle(document.documentElement);
    const labelColor = styles.getPropertyValue('--chart-label').trim() || 'rgba(148,163,184,.55)';
    const gridColor = styles.getPropertyValue('--chart-grid').trim() || 'rgba(148,163,184,.09)';
    const points = this.points();
    const key = this.data?.valueKey || 'latency';
    const color = this.data?.color || '#34e6c6';
    const label = this.data?.label || '延迟';
    const unit = this.data?.unit || '';
    const values = points.map((point) => (Number.isFinite(point[key]) ? point[key] : null));
    const finite = values.filter((value) => value != null);
    if (!points.length || !finite.length) {
      ctx.fillStyle = labelColor;
      ctx.font = MONO;
      ctx.textAlign = 'center';
      ctx.fillText(`该时间范围内暂无${label}样本`, this.width / 2, this.height / 2);
      return;
    }
    const { left, right, top, bottom } = this.padding;
    const maxRaw = Math.max(...finite);
    const max = unit === '%'
      ? Math.min(100, Math.max(20, Math.ceil((maxRaw * 1.2) / 10) * 10))
      : Math.max(20, Math.ceil((maxRaw * 1.2) / 10) * 10);
    const plotWidth = this.width - left - right;
    const plotHeight = this.height - top - bottom;

    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i += 1) {
      const y = top + (i / 3) * plotHeight;
      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(this.width - right, y);
      ctx.stroke();
      ctx.fillStyle = labelColor;
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(max - (i / 3) * max)}`, left - 8, y);
    }

    const xLabels = 5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < xLabels; i += 1) {
      const index = Math.round((i / (xLabels - 1)) * (points.length - 1));
      const x = left + (index / Math.max(1, points.length - 1)) * plotWidth;
      ctx.fillStyle = labelColor;
      ctx.textAlign = i === 0 ? 'left' : (i === xLabels - 1 ? 'right' : 'center');
      ctx.fillText(formatAxisTime(points[index].t, this.data.range), x, this.height - bottom + 8);
    }
    ctx.textAlign = 'center';

    const gradient = ctx.createLinearGradient(0, top, 0, top + plotHeight);
    gradient.addColorStop(0, hexToRgba(color, 0.24));
    gradient.addColorStop(1, hexToRgba(color, 0));

    const segments = [];
    let current = [];
    values.forEach((value, index) => {
      if (value == null) {
        if (current.length) {
          segments.push(current);
          current = [];
        }
        return;
      }
      current.push([this.xFor(index), this.yFor(value, max)]);
    });
    if (current.length) segments.push(current);

    for (const segment of segments) {
      if (segment.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(segment[0][0], top + plotHeight);
      for (const [x, y] of segment) ctx.lineTo(x, y);
      ctx.lineTo(segment[segment.length - 1][0], top + plotHeight);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.save();
    ctx.shadowColor = hexToRgba(color, 0.45);
    ctx.shadowBlur = 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const segment of segments) {
      if (segment.length < 2) {
        if (segment.length === 1) {
          ctx.beginPath();
          ctx.arc(segment[0][0], segment[0][1], 2, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      segment.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();

    // marks for failed buckets
    points.forEach((point, index) => {
      if (point.availability === 0) {
        const x = this.xFor(index);
        ctx.fillStyle = 'rgba(255,97,125,.75)';
        ctx.fillRect(x - 1, top + plotHeight - 3, 2, 3);
      }
    });

    if (this.hoverIndex >= 0 && this.hoverIndex < points.length) {
      const point = points[this.hoverIndex];
      const x = this.xFor(this.hoverIndex);
      ctx.strokeStyle = 'rgba(148,163,184,.3)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      const hoverValue = point[this.data?.valueKey || 'latency'];
      if (Number.isFinite(hoverValue)) {
        const y = this.yFor(hoverValue, max);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#05070d';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    }
  }

  onPointerMove(event) {
    const points = this.points();
    if (!points.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const { left, right } = this.padding;
    const ratio = (x - left) / Math.max(1, this.width - left - right);
    const index = Math.round(Math.min(1, Math.max(0, ratio)) * (points.length - 1));
    this.hoverIndex = index;
    this.draw();
    this.showTooltip(index, x);
  }

  showTooltip(index, x) {
    if (!this.tooltip) return;
    const point = this.points()[index];
    if (!point) return;
    const key = this.data?.valueKey || 'latency';
    const value = Number.isFinite(point[key]) ? `${point[key]}${this.data?.unit || ''}` : '无样本';
    const availability = point.availability == null ? '—' : `${point.availability}%`;
    this.tooltip.innerHTML = `<b>${formatFullTime(point.t, this.data.range)}</b><br>${this.data?.label || '延迟'} ${value} · 可用率 ${availability}`;
    const clampedX = Math.min(this.width - 70, Math.max(70, x));
    this.tooltip.style.transform = `translate(${clampedX}px, ${this.padding.top + 30}px) translate(-50%, -110%)`;
    this.tooltip.classList.add('is-visible');
  }

  onPointerLeave() {
    this.hoverIndex = -1;
    this.tooltip?.classList.remove('is-visible');
    this.draw();
  }
}
