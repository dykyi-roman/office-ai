// User settings store — loads from Tauri backend, saves on change with debounce
// Frontend-only settings (language, showPrompts) persist via localStorage.

import { TAURI_COMMANDS } from "$lib/types/index";
import type { Locale } from "$lib/i18n/translations";

const LOCAL_STORAGE_KEY = "officeai-settings";
const FRONTEND_ONLY_KEYS: ReadonlySet<keyof Settings> = new Set([
  "language",
  "showPrompts",
]);

// ---------------------------------------------------------------------------
// Settings type
// ---------------------------------------------------------------------------

export interface Settings {
  theme: "modern" | "retro" | "minimal";
  soundEnabled: boolean;
  showAgentMetrics: boolean;
  animationSpeed: number;
  showPrompts: boolean;
  debugMode: boolean;
  scanInterval: number;
  maxAgents: number;
  customLogPaths: string;
  language: Locale;
}

const DEFAULTS: Settings = {
  theme: "modern",
  soundEnabled: false,
  showAgentMetrics: true,
  animationSpeed: 1.0,
  showPrompts: true,
  debugMode: false,
  scanInterval: 2,
  maxAgents: 20,
  customLogPaths: "",
  language: "en",
};

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

let settings = $state<Settings>({ ...DEFAULTS });

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function schedulesSave(key: keyof Settings, value: Settings[typeof key]): void {
  if (saveTimeout !== null) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    persistSetting(key, value);
  }, 400);
}

async function persistSetting(
  key: keyof Settings,
  value: Settings[typeof key],
): Promise<void> {
  if (FRONTEND_ONLY_KEYS.has(key)) {
    saveFrontendSettings();
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(TAURI_COMMANDS.SET_CONFIG, { key, value: String(value) });
  } catch {
    // Tauri not available — silently ignore in dev mode
  }
}

function saveFrontendSettings(): void {
  try {
    const data: Record<string, unknown> = {};
    for (const key of FRONTEND_ONLY_KEYS) {
      data[key] = settings[key];
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable — ignore
  }
}

function loadFrontendSettings(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as Partial<Settings>;
    }
  } catch {
    // corrupted or unavailable — ignore
  }
  return {};
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let initialized = false;

export async function initSettingsStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const frontendOverrides = loadFrontendSettings();

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const loaded = await invoke<Partial<Settings>>(TAURI_COMMANDS.GET_CONFIG);
    settings = { ...DEFAULTS, ...loaded, ...frontendOverrides };
  } catch {
    // Tauri not available — use defaults + frontend overrides
    settings = { ...DEFAULTS, ...frontendOverrides };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return settings[key];
}

export function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  settings[key] = value;
  schedulesSave(key, value);
}

export function getSettings(): Settings {
  return settings;
}
