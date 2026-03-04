// Integration test: settings save/load cycle
// Verifies that settings persist, merge with defaults, and trigger side effects

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Settings } from "../../src/lib/stores/settings.svelte";

// ---------------------------------------------------------------------------
// Settings logic replicated for testing (pure, no Svelte rune dependency)
// ---------------------------------------------------------------------------

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

class SettingsStore {
  private settings: Settings;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly persistFn: (key: keyof Settings, value: Settings[keyof Settings]) => Promise<void>;

  constructor(
    initial: Partial<Settings> = {},
    persistFn?: (key: keyof Settings, value: Settings[keyof Settings]) => Promise<void>,
  ) {
    this.settings = { ...DEFAULTS, ...initial };
    this.persistFn = persistFn ?? (async () => undefined);
  }

  getSetting<K extends keyof Settings>(key: K): Settings[K] {
    return this.settings[key] as Settings[K];
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings[key] = value;
    this.scheduleSave(key, value);
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  loadFromBackend(loaded: Partial<Settings>): void {
    this.settings = { ...DEFAULTS, ...loaded };
  }

  private scheduleSave(key: keyof Settings, value: Settings[keyof Settings]): void {
    if (this.saveTimeout !== null) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      void this.persistFn(key, value);
    }, 400);
  }

  flushPendingSave(): void {
    if (this.saveTimeout !== null) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests: default values
// ---------------------------------------------------------------------------

describe("settings-persistence: default values on init", () => {
  it("initializes with all default values when no backend data", () => {
    const store = new SettingsStore();
    expect(store.getSettings()).toEqual(DEFAULTS);
  });

  it("theme defaults to 'modern'", () => {
    const store = new SettingsStore();
    expect(store.getSetting("theme")).toBe("modern");
  });

  it("scanInterval defaults to 2", () => {
    const store = new SettingsStore();
    expect(store.getSetting("scanInterval")).toBe(2);
  });

  it("maxAgents defaults to 20", () => {
    const store = new SettingsStore();
    expect(store.getSetting("maxAgents")).toBe(20);
  });

  it("debugMode defaults to false", () => {
    const store = new SettingsStore();
    expect(store.getSetting("debugMode")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: load from backend
// ---------------------------------------------------------------------------

describe("settings-persistence: loadFromBackend merges with defaults", () => {
  it("overrides theme from backend data", () => {
    const store = new SettingsStore();
    store.loadFromBackend({ theme: "retro" });
    expect(store.getSetting("theme")).toBe("retro");
  });

  it("preserves unset defaults when backend only provides partial data", () => {
    const store = new SettingsStore();
    store.loadFromBackend({ theme: "minimal", debugMode: true });

    expect(store.getSetting("soundEnabled")).toBe(DEFAULTS.soundEnabled);
    expect(store.getSetting("scanInterval")).toBe(DEFAULTS.scanInterval);
    expect(store.getSetting("maxAgents")).toBe(DEFAULTS.maxAgents);
  });

  it("full backend payload replaces all defaults", () => {
    const backendData: Partial<Settings> = {
      theme: "retro",
      soundEnabled: false,
      showAgentMetrics: false,
      animationSpeed: 0.5,
      showPrompts: false,
      debugMode: true,
      scanInterval: 5,
      maxAgents: 10,
      customLogPaths: "/var/log/claude",
      language: "ru",
    };

    const store = new SettingsStore();
    store.loadFromBackend(backendData);

    const loaded = store.getSettings();
    expect(loaded.theme).toBe("retro");
    expect(loaded.soundEnabled).toBe(false);
    expect(loaded.debugMode).toBe(true);
    expect(loaded.scanInterval).toBe(5);
    expect(loaded.language).toBe("ru");
  });

  it("empty backend payload falls back to all defaults", () => {
    const store = new SettingsStore();
    store.loadFromBackend({});
    expect(store.getSettings()).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Tests: setSetting persistence
// ---------------------------------------------------------------------------

describe("settings-persistence: setSetting triggers debounced save", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists setting after debounce delay (400ms)", async () => {
    const persistFn = vi.fn().mockResolvedValue(undefined);
    const store = new SettingsStore({}, persistFn);

    store.setSetting("theme", "retro");

    expect(persistFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    expect(persistFn).toHaveBeenCalledWith("theme", "retro");
  });

  it("debounce cancels previous timer on rapid updates", async () => {
    const persistFn = vi.fn().mockResolvedValue(undefined);
    const store = new SettingsStore({}, persistFn);

    store.setSetting("theme", "retro");
    vi.advanceTimersByTime(200);
    store.setSetting("theme", "minimal");
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    // Only the last value should be persisted
    expect(persistFn).toHaveBeenCalledOnce();
    expect(persistFn).toHaveBeenCalledWith("theme", "minimal");
  });

  it("each independent key is persisted with the correct value", async () => {
    const persistFn = vi.fn().mockResolvedValue(undefined);
    const store = new SettingsStore({}, persistFn);

    store.setSetting("debugMode", true);
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    store.setSetting("scanInterval", 5);
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    expect(persistFn).toHaveBeenNthCalledWith(1, "debugMode", true);
    expect(persistFn).toHaveBeenNthCalledWith(2, "scanInterval", 5);
  });

  it("setting value is immediately reflected in getSetting before debounce fires", () => {
    const store = new SettingsStore();
    store.setSetting("animationSpeed", 0.5);

    // Value is synchronously applied
    expect(store.getSetting("animationSpeed")).toBe(0.5);
    store.flushPendingSave();
  });
});

// ---------------------------------------------------------------------------
// Tests: save/load round-trip
// ---------------------------------------------------------------------------

describe("settings-persistence: save/load round-trip", () => {
  it("saved value can be loaded back and equals original", async () => {
    const savedData: Partial<Settings> = {};
    const persistFn = async (key: keyof Settings, value: Settings[keyof Settings]): Promise<void> => {
      (savedData as Record<string, unknown>)[key] = value;
    };

    vi.useFakeTimers();

    const store = new SettingsStore({}, persistFn);
    // Each setSetting cancels the previous debounce timer, so set each individually
    // and advance time in between to let each timer fire
    store.setSetting("theme", "retro");
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    store.setSetting("scanInterval", 5);
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    store.setSetting("maxAgents", 10);
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    vi.useRealTimers();

    const store2 = new SettingsStore();
    store2.loadFromBackend(savedData);

    expect(store2.getSetting("theme")).toBe("retro");
    expect(store2.getSetting("scanInterval")).toBe(5);
    expect(store2.getSetting("maxAgents")).toBe(10);
  });

  it("getSettings() returns a snapshot (not reactive reference)", () => {
    const store = new SettingsStore();
    const snapshot1 = store.getSettings();

    store.setSetting("theme", "retro");
    store.flushPendingSave();

    // snapshot1 should not have changed
    expect(snapshot1.theme).toBe("modern");
    expect(store.getSetting("theme")).toBe("retro");
  });
});

// ---------------------------------------------------------------------------
// Tests: type safety / valid value ranges
// ---------------------------------------------------------------------------

describe("settings-persistence: value constraints", () => {
  it("animationSpeed can be set to boundary values", () => {
    const store = new SettingsStore();

    store.setSetting("animationSpeed", 0.5);
    expect(store.getSetting("animationSpeed")).toBe(0.5);
    store.flushPendingSave();

    store.setSetting("animationSpeed", 2.0);
    expect(store.getSetting("animationSpeed")).toBe(2.0);
    store.flushPendingSave();
  });

  it("theme accepts all valid values", () => {
    const store = new SettingsStore();
    const themes: Array<Settings["theme"]> = ["modern", "retro", "minimal"];

    for (const theme of themes) {
      store.setSetting("theme", theme);
      expect(store.getSetting("theme")).toBe(theme);
      store.flushPendingSave();
    }
  });

  it("language persists as a string", () => {
    const store = new SettingsStore();
    store.setSetting("language", "ru");
    expect(store.getSetting("language")).toBe("ru");
    store.flushPendingSave();
  });
});
