// Appearance preferences: persisted locally, and synced to the account when signed in.
export const DEFAULT_PREFERENCES = Object.freeze({
  style: 'cosmos',
  accent: 'mint',
  density: 'comfortable',
  effects: true,
  motion: true,
});

export const STYLE_PRESETS = Object.freeze({
  cosmos: { label: '深空', description: '玻璃 · 极光 · 深色', theme: 'dark', accent: 'mint' },
  paper: { label: '纸境', description: '编辑排版 · 暖白', theme: 'light', accent: 'amber' },
  terminal: { label: '终端', description: '等宽 · 网格 · 霓虹', theme: 'dark', accent: 'lime' },
  gilded: { label: '鎏金', description: '衬线 · 金色 · 克制', theme: 'dark', accent: 'champagne' },
  popipa: { label: "Poppin'Party", description: '星光 · 粉黄 · 元气', theme: 'dark', accent: 'popipa-pink' },
  afterglow: { label: 'Afterglow', description: '余烬 · 红黑 · 摇滚', theme: 'dark', accent: 'afterglow-red' },
  pasupare: { label: 'Pastel＊Palettes', description: '粉彩 · 柔和 · 偶像', theme: 'light', accent: 'pasupare-pink' },
  roselia: { label: 'Roselia', description: '紫蔷薇 · 古典 · 冷冽', theme: 'dark', accent: 'roselia-violet' },
  hhw: { label: 'ハロー ハッピーワールド！', description: '糖果 · 明亮 · 欢乐', theme: 'light', accent: 'hhw-yellow' },
  morfonica: { label: 'Morfonica', description: '蓝白 · 优雅 · 古典', theme: 'light', accent: 'morfonica-blue' },
  ras: { label: 'RAISE A SUILEN', description: '黑黄 · 电子 · 锐利', theme: 'dark', accent: 'ras-yellow' },
  mewtype: { label: '夢限大みゅーたいぷ', description: '梦境 · 紫粉 · 未来', theme: 'light', accent: 'mewtype-pink' },
});

export const ACCENTS = Object.freeze({
  mint: { color: '#34e6c6', second: '#8b8bff' },
  azure: { color: '#5ba8ff', second: '#7c8bff' },
  violet: { color: '#a78bfa', second: '#f0abfc' },
  amber: { color: '#ffb85c', second: '#ff8f5c' },
  rose: { color: '#ff7fa3', second: '#c084fc' },
  champagne: { color: '#e6c48a', second: '#f3ddb0' },
  lime: { color: '#7cffb2', second: '#2dd4bf' },
  'popipa-pink': { color: '#ff7eb6', second: '#ffd166' },
  'afterglow-red': { color: '#ff5a5f', second: '#ff9f45' },
  'pasupare-pink': { color: '#ff9ec7', second: '#a8d8ff' },
  'roselia-violet': { color: '#9a7bff', second: '#5b8cff' },
  'hhw-yellow': { color: '#ffd83d', second: '#ff8ec7' },
  'morfonica-blue': { color: '#7fb7ff', second: '#c9b8ff' },
  'ras-yellow': { color: '#e8ff4f', second: '#7cffb2' },
  'mewtype-pink': { color: '#ff9edb', second: '#d6a8ff' },
});

const STORAGE_KEY = 'eleganza.preferences';

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizePreferences(input, base = DEFAULT_PREFERENCES) {
  const source = input && typeof input === 'object' ? input : {};
  const merged = { ...DEFAULT_PREFERENCES, ...base, ...source };
  // Older versions stored only dark/light; map them into a full visual style.
  const style = merged.style ? oneOf(merged.style, Object.keys(STYLE_PRESETS), 'cosmos')
    : (merged.theme === 'light' ? 'paper' : 'cosmos');
  return {
    style,
    accent: oneOf(merged.accent, Object.keys(ACCENTS), STYLE_PRESETS[style].accent),
    density: oneOf(merged.density, ['comfortable', 'compact'], 'comfortable'),
    effects: merged.effects !== false,
    motion: merged.motion !== false,
  };
}

export function loadPreferences() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return normalizePreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
  } catch {
    // storage can be unavailable in private browsing; appearance still works for the session
  }
}

export function accentColor(preferences = DEFAULT_PREFERENCES) {
  return (ACCENTS[preferences.accent] || ACCENTS.mint).color;
}

export function accentSecondColor(preferences = DEFAULT_PREFERENCES) {
  return (ACCENTS[preferences.accent] || ACCENTS.mint).second;
}

export function applyPreferences(preferences) {
  const prefs = normalizePreferences(preferences);
  const style = STYLE_PRESETS[prefs.style] || STYLE_PRESETS.cosmos;
  const root = document.documentElement;
  root.dataset.style = prefs.style;
  root.dataset.theme = style.theme;
  root.dataset.accent = prefs.accent;
  root.dataset.band = ['popipa', 'afterglow', 'pasupare', 'roselia', 'hhw', 'morfonica', 'ras', 'mewtype'].includes(prefs.style)
    ? 'true'
    : 'false';
  root.dataset.density = prefs.density;
  root.dataset.effects = prefs.effects ? 'on' : 'off';
  root.dataset.motion = prefs.motion ? 'on' : 'off';
  root.style.colorScheme = style.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const colors = {
      cosmos: '#05070d',
      paper: '#f4efe5',
      terminal: '#020604',
      gilded: '#07080d',
      popipa: '#120b1b',
      afterglow: '#0b0909',
      pasupare: '#fff6fb',
      roselia: '#080510',
      hhw: '#fff9e8',
      morfonica: '#f4f9ff',
      ras: '#050505',
      mewtype: '#0d0718',
    };
    meta.setAttribute('content', colors[prefs.style] || '#05070d');
  }
  return prefs;
}
