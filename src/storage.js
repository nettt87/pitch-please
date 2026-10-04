const KEY = "chroma-ap-v1";
// v2: new defaults (white keys, octave 4); older saved settings are set aside once.
const SETTINGS_KEY = "chroma-ap-settings-v2";

export const emptyStats = () => ({
  bestStreak: 0,
  byPc: Array.from({ length: 12 }, () => ({ hits: 0, misses: 0 })),
  produceLocks: 0,
});

export function loadStats() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyStats();
    return { ...emptyStats(), ...JSON.parse(raw) };
  } catch {
    return emptyStats();
  }
}

export function saveStats(stats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stats));
  } catch {
    // Storage can be unavailable (private mode); stats then last for the session only.
  }
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Same as saveStats.
  }
}

export function recordIdentify(stats, pc, correct) {
  const next = structuredClone(stats);
  const row = next.byPc[pc];
  if (correct) row.hits += 1;
  else row.misses += 1;
  return next;
}
