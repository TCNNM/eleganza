// The globe: an orthographic, dotted planet with live nodes and arcs.
const STATUS_COLOR = {
  online: '#35e0a1',
  warning: '#ffb85c',
  offline: '#ff617d',
  pending: '#8f9bff',
};

const STATUS_TEXT = {
  online: '正常',
  warning: '注意',
  offline: '离线',
  pending: '待探测',
};

const DEG = Math.PI / 180;

function decodeLand() {
  const source = window.ELEGANZA_LAND;
  const bytes = Uint8Array.from(atob(source.data), (ch) => ch.charCodeAt(0));
  const dots = [];
  for (let row = 0; row < source.height; row += 1) {
    for (let col = 0; col < source.width; col += 1) {
      const index = row * source.width + col;
      if (!(bytes[index >> 3] & (0x80 >> (index & 7)))) continue;
      const lat = (-90 + (row + 0.5) * source.step) * DEG;
      const lon = (-180 + (col + 0.5) * source.step) * DEG;
      const cosLat = Math.cos(lat);
      dots.push({
        y: Math.sin(lat),
        x: cosLat * Math.cos(lon),
        z: cosLat * Math.sin(lon),
      });
    }
  }
  return dots;
}

function toVector(lat, lon) {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosLat = Math.cos(phi);
  return [cosLat * Math.cos(lambda), Math.sin(phi), cosLat * Math.sin(lambda)];
}

function slerp(a, b, steps) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    let x;
    let y;
    let z;
    if (sinOmega < 1e-6) {
      x = a[0] + (b[0] - a[0]) * t;
      y = a[1] + (b[1] - a[1]) * t;
      z = a[2] + (b[2] - a[2]) * t;
    } else {
      const w1 = Math.sin((1 - t) * omega) / sinOmega;
      const w2 = Math.sin(t * omega) / sinOmega;
      x = a[0] * w1 + b[0] * w2;
      y = a[1] * w1 + b[1] * w2;
      z = a[2] * w1 + b[2] * w2;
    }
    const length = Math.hypot(x, y, z) || 1;
    out.push({ x: x / length, y: y / length, z: z / length, t });
  }
  return out;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function shortestAngle(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function hexToRgb(hex) {
  const value = String(hex || '#34e6c6').replace('#', '');
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return '52,230,198';
  return `${(int >> 16) & 255},${(int >> 8) & 255},${int & 255}`;
}

export class Globe {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.accent = options.accent || '#34e6c6';
    this.accentRgb = hexToRgb(this.accent);
    this.hub = options.hub || { lat: 31.23, lon: 121.47, name: '探针中枢' };
    this.onSelect = options.onSelect || (() => {});
    this.onCoordChange = options.onCoordChange || (() => {});
    this.paused = false;
    this.dragging = false;
    this.hovered = null;
    this.targets = [];
    this.markers = [];
    this.arcs = [];
    this.land = decodeLand();
    this.landBuckets = [
      { coords: new Float32Array(this.land.length * 2), count: 0, size: 1.25, fill: 'rgba(100, 140, 182, 0.3)' },
      { coords: new Float32Array(this.land.length * 2), count: 0, size: 1.45, fill: 'rgba(128, 170, 212, 0.48)' },
      { coords: new Float32Array(this.land.length * 2), count: 0, size: 1.9, fill: 'rgba(172, 214, 242, 0.72)' },
    ];
    this.stars = Array.from({ length: 90 }, (_, index) => {
      const angle = (index * 2.399963) % (Math.PI * 2);
      const radius = 0.5 + ((index * 37) % 100) / 200;
      return {
        ox: Math.cos(angle) * radius,
        oy: Math.sin(angle) * radius,
        size: ((index * 13) % 10) / 10 > 0.72 ? 1.5 : 1,
        alpha: 0.1 + ((index * 29) % 100) / 260,
      };
    });
    this.width = 0;
    this.height = 0;
    this.lambda = 105 * DEG;
    this.phi = 22 * DEG;
    this.tween = null;
    this.lastFrame = performance.now();
    this.lastCoord = 0;
    this.autoSpeed = 0.035;
    this.frame = this.frame.bind(this);
    this.pointerDown = this.pointerDown.bind(this);
    this.pointerMove = this.pointerMove.bind(this);
    this.pointerUp = this.pointerUp.bind(this);

    this.canvas.addEventListener('pointerdown', this.pointerDown);
    this.canvas.addEventListener('pointermove', this.pointerMove);
    this.canvas.addEventListener('pointerup', this.pointerUp);
    this.canvas.addEventListener('pointercancel', this.pointerUp);
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.dragging) this.setHover(null);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
  }

  setData(nodes) {
    this.targets = nodes.filter((node) => Number.isFinite(node.lat) && Number.isFinite(node.lon));
    const hub = toVector(this.hub.lat, this.hub.lon);
    this.arcs = this.targets.map((node) => {
      const vector = toVector(node.lat, node.lon);
      const angular = Math.acos(Math.min(1, Math.max(-1, hub[0] * vector[0] + hub[1] * vector[1] + hub[2] * vector[2])));
      const lift = 0.05 + Math.min(0.24, angular * 0.14);
      return {
        id: node.id,
        status: node.status,
        points: slerp(hub, vector, 44),
        lift,
        phase: ((node.id.charCodeAt(0) * 7 + node.id.length * 13) % 100) / 100,
      };
    });
  }

  setSelected(id) {
    this.selectedId = id;
    if (id) this.focusOnNode(id, true);
  }

  focusOnNode(id, animate = true) {
    const node = this.targets.find((item) => item.id === id);
    if (!node) return;
    const targetLambda = node.lon * DEG;
    const targetPhi = Math.max(-0.85, Math.min(0.85, node.lat * DEG * 0.9));
    if (!animate) {
      this.lambda = targetLambda;
      this.phi = targetPhi;
      return;
    }
    this.tween = {
      fromLambda: this.lambda,
      deltaLambda: shortestAngle(this.lambda, targetLambda),
      fromPhi: this.phi,
      toPhi: targetPhi,
      start: performance.now(),
      duration: 900,
    };
    this.idleUntil = performance.now() + 4000;
  }

  setAccent(hex) {
    this.accent = hex || '#34e6c6';
    this.accentRgb = hexToRgb(this.accent);
  }

  setPaused(value) {
    this.paused = value;
    this.idleUntil = 0;
    return this.paused;
  }

  toggle() {
    return this.setPaused(!this.paused);
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.radius = Math.min(rect.width, rect.height) * 0.415;
  }

  geometry() {
    const cx = this.width / 2;
    const cy = this.height / 2 + this.radius * 0.02;
    return {
      cx,
      cy,
      r: this.radius,
      cosPhi: Math.cos(this.phi),
      sinPhi: Math.sin(this.phi),
      cosLam: Math.cos(this.lambda),
      sinLam: Math.sin(this.lambda),
    };
  }

  projectUnit(x, y, z, geo, scale = 1) {
    // x = cos(lat)·cos(lon), z = cos(lat)·sin(lon); lambda is the centre longitude.
    const xr = z * geo.cosLam - x * geo.sinLam;
    const zr = x * geo.cosLam + z * geo.sinLam;
    const yTilt = y * geo.cosPhi - zr * geo.sinPhi;
    const zTilt = y * geo.sinPhi + zr * geo.cosPhi;
    return {
      x: geo.cx + geo.r * scale * xr,
      y: geo.cy - geo.r * scale * yTilt,
      z: zTilt,
    };
  }

  projectLatLon(lat, lon, geo, scale = 1) {
    const phi = lat * DEG;
    const lambda = lon * DEG;
    const cosLat = Math.cos(phi);
    return this.projectUnit(cosLat * Math.cos(lambda), Math.sin(phi), cosLat * Math.sin(lambda), geo, scale);
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.tween) {
      const t = Math.min(1, (now - this.tween.start) / this.tween.duration);
      const eased = 1 - (1 - t) ** 3;
      this.lambda = this.tween.fromLambda + this.tween.deltaLambda * eased;
      this.phi = mix(this.tween.fromPhi, this.tween.toPhi, eased);
      if (t >= 1) this.tween = null;
    } else if (!this.paused && !this.dragging && (!this.idleUntil || now > this.idleUntil)) {
      this.lambda += this.autoSpeed * dt;
    }
    if (this.lambda > Math.PI) this.lambda -= Math.PI * 2;
    if (this.lambda < -Math.PI) this.lambda += Math.PI * 2;

    this.render(now, dt);
    if (now - this.lastCoord > 160) {
      this.lastCoord = now;
      const centerLat = this.phi / DEG;
      let centerLon = this.lambda / DEG;
      while (centerLon > 180) centerLon -= 360;
      while (centerLon < -180) centerLon += 360;
      this.onCoordChange(centerLat, centerLon);
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  render(now, dt) {
    const ctx = this.ctx;
    if (!this.width || !this.height) return;
    ctx.clearRect(0, 0, this.width, this.height);
    const geo = this.geometry();
    const { cx, cy, r } = geo;

    // distant stars
    for (const star of this.stars) {
      const alpha = star.alpha * (0.65 + 0.35 * Math.sin(now / 1400 + star.ox * 9));
      ctx.fillStyle = `rgba(196, 214, 240, ${alpha.toFixed(3)})`;
      ctx.fillRect(cx + star.ox * r * 1.55, cy + star.oy * r * 1.55, star.size, star.size);
    }

    // atmosphere
    const atmosphere = ctx.createRadialGradient(cx, cy, r * 0.86, cx, cy, r * 1.24);
    atmosphere.addColorStop(0, `rgba(${this.accentRgb},.08)`);
    atmosphere.addColorStop(0.55, `rgba(${this.accentRgb},.035)`);
    atmosphere.addColorStop(1, `rgba(${this.accentRgb},0)`);
    ctx.fillStyle = atmosphere;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.24, 0, Math.PI * 2);
    ctx.fill();

    // ocean
    const ocean = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.4, r * 0.08, cx, cy, r);
    ocean.addColorStop(0, 'rgba(30, 50, 76, 0.55)');
    ocean.addColorStop(0.55, 'rgba(12, 22, 38, 0.72)');
    ocean.addColorStop(1, 'rgba(4, 8, 16, 0.92)');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = ocean;
    ctx.fill();

    // rim
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 190, 210, 0.22)';
    ctx.lineWidth = 1;
    ctx.shadowColor = `rgba(${this.accentRgb}, 0.35)`;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    this.drawGraticule(geo);

    // land dots
    const front = this.landBuckets;
    for (const bucket of front) bucket.count = 0;
    const cosPhi = geo.cosPhi;
    const sinPhi = geo.sinPhi;
    const cosLam = geo.cosLam;
    const sinLam = geo.sinLam;
    for (let i = 0; i < this.land.length; i += 1) {
      const dot = this.land[i];
      const xr = dot.z * cosLam - dot.x * sinLam;
      const zr = dot.x * cosLam + dot.z * sinLam;
      const yTilt = dot.y * cosPhi - zr * sinPhi;
      const zTilt = dot.y * sinPhi + zr * cosPhi;
      if (zTilt < 0.015) continue;
      let bucket;
      if (zTilt > 0.82) bucket = front[2];
      else if (zTilt > 0.38) bucket = front[1];
      else bucket = front[0];
      const index = bucket.count * 2;
      bucket.coords[index] = cx + r * xr;
      bucket.coords[index + 1] = cy - r * yTilt;
      bucket.count += 1;
    }
    for (const bucket of front) {
      if (!bucket.count) continue;
      ctx.fillStyle = bucket.fill;
      const size = bucket.size;
      ctx.beginPath();
      for (let i = 0; i < bucket.count; i += 1) {
        ctx.rect(bucket.coords[i * 2], bucket.coords[i * 2 + 1], size, size);
      }
      ctx.fill();
    }

    this.drawArcs(geo, now, dt);
    this.drawHub(geo, now);
    this.drawMarkers(geo, now);
  }

  drawGraticule(geo) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(120, 158, 198, 0.09)';
    ctx.lineWidth = 1;
    for (let lon = -180; lon < 180; lon += 30) {
      ctx.beginPath();
      let started = false;
      for (let lat = -90; lat <= 90; lat += 3) {
        const point = this.projectLatLon(lat, lon, geo);
        if (point.z <= 0.01) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(point.x, point.y);
          started = true;
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }
      ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath();
      let started = false;
      for (let lon = -180; lon <= 180; lon += 3) {
        const point = this.projectLatLon(lat, lon, geo);
        if (point.z <= 0.01) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(point.x, point.y);
          started = true;
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120, 158, 198, 0.05)';
    ctx.beginPath();
    ctx.arc(geo.cx, geo.cy, geo.r * 0.995, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawArcs(geo, now, dt) {
    const ctx = this.ctx;
    for (const arc of this.arcs) {
      const color = STATUS_COLOR[arc.status] || STATUS_COLOR.online;
      const points = arc.points;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash(arc.status === 'offline' ? [3, 5] : []);
      ctx.lineDashOffset = arc.status === 'offline' ? -((now / 90) % 8) : 0;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.32;
      ctx.beginPath();
      let started = false;
      for (const point of points) {
        const scale = 1 + arc.lift * Math.sin(Math.PI * point.t);
        const projected = this.projectUnit(point.x, point.y, point.z, geo, scale);
        if (projected.z <= 0.005) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(projected.x, projected.y);
          started = true;
        } else {
          ctx.lineTo(projected.x, projected.y);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  drawHub(geo, now) {
    const ctx = this.ctx;
    const point = this.projectLatLon(this.hub.lat, this.hub.lon, geo);
    if (point.z <= 0.02) return;
    const pulse = (Math.sin(now / 900) + 1) / 2;
    ctx.save();
    ctx.strokeStyle = `rgba(${this.accentRgb},.45)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5.5 + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 10 + pulse * 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.accent;
    ctx.shadowColor = this.accent;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawMarkers(geo, now) {
    const ctx = this.ctx;
    this.markers = [];
    const labels = [];
    for (const node of this.targets) {
      const point = this.projectLatLon(node.lat, node.lon, geo);
      const visible = point.z > 0.02;
      this.markers.push({ id: node.id, x: point.x, y: point.y, z: point.z, visible, node });
      if (!visible) continue;
      const color = STATUS_COLOR[node.status] || STATUS_COLOR.online;
      const depth = Math.min(1, Math.max(0.15, point.z));
      const isHovered = this.hovered === node.id;
      const isSelected = this.selectedId === node.id;

      // pulse
      const phase = ((now / 2600) + node.lon / 360 + node.lat / 180) % 1;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = (1 - phase) * 0.4 * depth;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4 + phase * 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // glow
      const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, isHovered || isSelected ? 16 : 11);
      glow.addColorStop(0, `${color}66`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, isHovered || isSelected ? 16 : 11, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(point.x, point.y, isHovered || isSelected ? 4.4 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(4, 10, 18, 0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      if (point.z > 0.22 || isHovered || isSelected) {
        labels.push({
          node,
          x: point.x,
          y: point.y,
          z: point.z,
          color,
          priority: (isHovered || isSelected ? 10 : 0) + point.z,
        });
      }
    }

    labels.sort((a, b) => b.priority - a.priority);
    const boxes = [];
    ctx.font = '10px "Inter", "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';
    for (const label of labels) {
      const text = label.node.name;
      const textWidth = ctx.measureText(text).width;
      const boxWidth = textWidth + 26;
      const boxHeight = 19;
      const toRight = label.x < geo.cx;
      let x = toRight ? label.x + 11 : label.x - 11 - boxWidth;
      let y = label.y - boxHeight / 2;
      x = Math.max(4, Math.min(this.width - boxWidth - 4, x));
      y = Math.max(4, Math.min(this.height - boxHeight - 4, y));
      const box = { x, y, w: boxWidth, h: boxHeight };
      const collides = boxes.some((other) => !(box.x + box.w + 2 < other.x || box.x > other.x + other.w + 2 || box.y + box.h + 2 < other.y || box.y > other.y + other.h + 2));
      if (collides && label.priority < 9) continue;
      boxes.push(box);

      ctx.save();
      ctx.globalAlpha = 0.7 + 0.3 * label.z;
      roundRect(ctx, x, y, boxWidth, boxHeight, 6);
      ctx.fillStyle = 'rgba(5, 10, 18, 0.82)';
      ctx.fill();
      ctx.strokeStyle = `${label.color}55`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = label.color;
      ctx.beginPath();
      ctx.arc(x + 9, y + boxHeight / 2, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(226, 236, 248, 0.94)';
      ctx.fillText(text, x + 16, y + boxHeight / 2 + 0.5);
      ctx.restore();
    }
  }

  hitTest(x, y) {
    let best = null;
    for (const marker of this.markers) {
      if (!marker.visible) continue;
      const distance = Math.hypot(marker.x - x, marker.y - y);
      if (distance < 15 && (!best || distance < best.distance)) best = { ...marker, distance };
    }
    return best;
  }

  setHover(id) {
    if (this.hovered === id) return;
    this.hovered = id;
    this.canvas.style.cursor = id ? 'pointer' : 'grab';
    if (this.onHover) this.onHover(id);
    const tooltip = document.getElementById('globe-tooltip');
    if (!tooltip) return;
    if (!id) {
      tooltip.hidden = true;
      return;
    }
    const marker = this.markers.find((item) => item.id === id);
    if (!marker) {
      tooltip.hidden = true;
      return;
    }
    const node = marker.node;
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${escapeHtml(node.name)}</strong><span>${escapeHtml(node.city || node.group || '')} · ${STATUS_TEXT[node.status] || ''}${node.latencyMs != null ? ` · ${node.latencyMs} ms` : ''}</span>`;
    tooltip.style.left = `${marker.x}px`;
    tooltip.style.top = `${marker.y}px`;
  }

  pointerDown(event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    this.dragging = true;
    this.dragDistance = 0;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.tween = null;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
    this.setHover(null);
  }

  pointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (this.dragging) {
      const dx = event.clientX - this.lastX;
      const dy = event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
      this.lambda -= dx * 0.006;
      this.phi = Math.max(-0.95, Math.min(0.95, this.phi + dy * 0.004));
      this.idleUntil = performance.now() + 2500;
      return;
    }
    const hit = this.hitTest(x, y);
    this.setHover(hit?.id || null);
  }

  pointerUp(event) {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab';
    if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.idleUntil = performance.now() + 2500;
    if (this.dragDistance < 6) {
      const rect = this.canvas.getBoundingClientRect();
      const hit = this.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (hit) this.onSelect(hit.id);
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
