/**
 * UI Preferences — localStorage persistence for user interface settings.
 *
 * Inspired by OpenClaw's ui/storage.ts pattern:
 * - Scoped key: "super-agent.ui-prefs.v1"
 * - Structured read/write with defaults
 * - Safe for SSR (guards against window/localStorage absence)
 */

const STORAGE_KEY = "super-agent.ui-prefs.v1";

export interface UIPreferences {
  /** Color theme */
  theme: "dark" | "light" | "system";
  /** Whether the sidebar is collapsed (mobile: always starts closed) */
  sidebarCollapsed: boolean;
  /** Show LLM thinking/reasoning blocks in chat */
  chatShowThinking: boolean;
  /** Show tool call details in chat */
  chatShowToolCalls: boolean;
  /** Chat message font size in px */
  chatFontSize: number;
  /** UI locale */
  locale: string;
}

const DEFAULTS: UIPreferences = {
  theme: "dark",
  sidebarCollapsed: false,
  chatShowThinking: true,
  chatShowToolCalls: true,
  chatFontSize: 14,
  locale: "zh-CN",
};

/** Check if localStorage is available (SSR-safe) */
function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

/** Load UI preferences from localStorage (returns defaults if unavailable) */
export function loadPreferences(): UIPreferences {
  if (!hasLocalStorage()) return { ...DEFAULTS };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UIPreferences>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Save a partial set of preferences (merges with existing) */
export function savePreferences(prefs: Partial<UIPreferences>): void {
  if (!hasLocalStorage()) return;

  try {
    const current = loadPreferences();
    const merged = { ...current, ...prefs };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // localStorage may be full or blocked
  }
}

/** Get a single preference value */
export function getPreference<K extends keyof UIPreferences>(key: K): UIPreferences[K] {
  return loadPreferences()[key];
}

/** Set a single preference value */
export function setPreference<K extends keyof UIPreferences>(key: K, value: UIPreferences[K]): void {
  savePreferences({ [key]: value } as Partial<UIPreferences>);
}

/** Reset all preferences to defaults */
export function resetPreferences(): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULTS));
  } catch {
    // ignore
  }
}
