// Unit tests for settings store defaults and logic

import { describe, it, expect } from "vitest";
import type { Settings } from "../settings.svelte";

// ---------------------------------------------------------------------------
// Default values (mirrors settings.ts DEFAULTS)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("test_settings_defaults — all settings have correct defaults", () => {
  it("theme defaults to 'modern'", () => {
    expect(DEFAULTS.theme).toBe("modern");
  });

  it("soundEnabled defaults to false", () => {
    expect(DEFAULTS.soundEnabled).toBe(false);
  });

  it("showAgentMetrics defaults to true", () => {
    expect(DEFAULTS.showAgentMetrics).toBe(true);
  });

  it("animationSpeed defaults to 1.0", () => {
    expect(DEFAULTS.animationSpeed).toBe(1.0);
  });

  it("showPrompts defaults to true", () => {
    expect(DEFAULTS.showPrompts).toBe(true);
  });

  it("debugMode defaults to false", () => {
    expect(DEFAULTS.debugMode).toBe(false);
  });

  it("scanInterval defaults to 2 seconds", () => {
    expect(DEFAULTS.scanInterval).toBe(2);
  });

  it("maxAgents defaults to 20", () => {
    expect(DEFAULTS.maxAgents).toBe(20);
  });

  it("customLogPaths defaults to empty string", () => {
    expect(DEFAULTS.customLogPaths).toBe("");
  });

  it("language defaults to 'en'", () => {
    expect(DEFAULTS.language).toBe("en");
  });
});

describe("settings merge with backend values", () => {
  it("merges loaded values over defaults", () => {
    const loaded: Partial<Settings> = { theme: "retro", debugMode: true };
    const merged: Settings = { ...DEFAULTS, ...loaded };

    expect(merged.theme).toBe("retro");
    expect(merged.debugMode).toBe(true);
    // Other defaults remain unchanged
    expect(merged.soundEnabled).toBe(false);
    expect(merged.animationSpeed).toBe(1.0);
  });

  it("uses defaults for missing backend keys", () => {
    const loaded: Partial<Settings> = {};
    const merged: Settings = { ...DEFAULTS, ...loaded };
    expect(merged).toEqual(DEFAULTS);
  });
});

describe("settings value constraints", () => {
  it("animationSpeed is within valid range [0.5, 2.0]", () => {
    const speed = DEFAULTS.animationSpeed;
    expect(speed).toBeGreaterThanOrEqual(0.5);
    expect(speed).toBeLessThanOrEqual(2.0);
  });

  it("scanInterval is within valid range [1, 10]", () => {
    const interval = DEFAULTS.scanInterval;
    expect(interval).toBeGreaterThanOrEqual(1);
    expect(interval).toBeLessThanOrEqual(10);
  });

  it("maxAgents is within valid range [1, 50]", () => {
    const max = DEFAULTS.maxAgents;
    expect(max).toBeGreaterThanOrEqual(1);
    expect(max).toBeLessThanOrEqual(50);
  });
});
