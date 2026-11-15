// Appearance preferences: persisted locally, and synced to the account when signed in.
export const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'dark',
  accent: 'mint',
  density: 'comfortable',
  effects: true,
  motion: true,
});

export const ACCENTS = Object.freeze({
  mint: { color: '#34e6c6', second: '#8b8bff' },
  azure: { color: '#5ba8ff', second: '#7c8bff' },
  violet: { color: '#a78bfa', second: '#f0abfc' },
  amber: { color: '#ffb85c', second: '#ff8f5c' },
  rose: { color: '#ff7fa3', second: '#c084fc' },
  champagne: { color: '#e6c48a', second: '#f3ddb0' },
});

const STORAGE_KEY = 'eleganza.preferences';

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizePreferences(input, base = DEFAULT_PREFERENCES) {
  const source = input && typeof input === 'object' ? input : {};
  const merged = { ...DEFAULT_PREFERENCES, ...base, ...source };
  return {
    theme: oneOf(merged.theme, ['dark', 'light'], 'dark'),
    accent: oneOf(merged.accent, Object.keys(ACCENTS), 'mint'),
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
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.accent = prefs.accent;
  root.dataset.density = prefs.density;
  root.dataset.effects = prefs.effects ? 'on' : 'off';
  root.dataset.motion = prefs.motion ? 'on' : 'off';
  root.style.colorScheme = prefs.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', prefs.theme === 'light' ? '#f4f6fb' : '#05070d');
  return prefs;
}
