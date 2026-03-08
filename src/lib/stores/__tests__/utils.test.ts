// Unit tests for UI utility functions

import { describe, it, expect } from "vitest";
import {
  formatTokens,
  formatUptime,
  statusColor,
  tierColor,
  statusLabel,
  truncate,
  formatTime,
} from "../../ui/utils";

describe("formatTokens", () => {
  it("test_token_format_small — values under 1000 rendered as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  it("test_token_format_thousands — 1234 → '1.2K'", () => {
    expect(formatTokens(1234)).toBe("1.2K");
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(45200)).toBe("45.2K");
  });

  it("test_token_format_millions — 1234567 → '1.2M'", () => {
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(12_500_000)).toBe("12.5M");
  });
});

describe("formatUptime", () => {
  it("formats seconds only when under 1 minute", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(59)).toBe("59s");
  });

  it("formats minutes and seconds when under 1 hour", () => {
    expect(formatUptime(60)).toBe("1m 0s");
    expect(formatUptime(154)).toBe("2m 34s");
    expect(formatUptime(3599)).toBe("59m 59s");
  });

  it("formats hours and minutes when 1 hour or more", () => {
    expect(formatUptime(3600)).toBe("1h 0m");
    expect(formatUptime(9000)).toBe("2h 30m");
    expect(formatUptime(9154)).toBe("2h 32m");
  });
});

describe("statusColor", () => {
  it("returns distinct colors for each status", () => {
    const statuses = [
      "idle",
      "walking_to_desk",
      "thinking",
      "responding",
      "tool_use",
      "collaboration",
      "task_complete",
      "error",
      "offline",
    ] as const;

    const colors = statuses.map((s) => statusColor(s));
    // Each status has a color
    for (const color of colors) {
      expect(typeof color).toBe("string");
      expect(color.length).toBeGreaterThan(0);
    }
    // Colors should differ between at least some statuses
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBeGreaterThan(1);
  });

  it("idle status gets gray color", () => {
    expect(statusColor("idle")).toBe("#888888");
  });

  it("error status gets red color", () => {
    expect(statusColor("error")).toBe("#ef4444");
  });
});

describe("tierColor", () => {
  it("expert gets gold", () => {
    expect(tierColor("expert")).toBe("#ffd700");
  });

  it("senior gets blue", () => {
    expect(tierColor("senior")).toBe("#4a9eff");
  });

  it("middle gets green", () => {
    expect(tierColor("middle")).toBe("#22c55e");
  });

  it("junior gets grey", () => {
    expect(tierColor("junior")).toBe("#9ca3af");
  });
});

describe("statusLabel", () => {
  it("returns human-readable label for thinking", () => {
    expect(statusLabel("thinking")).toBe("Thinking...");
  });

  it("returns human-readable label for idle", () => {
    expect(statusLabel("idle")).toBe("Idle");
  });

  it("returns human-readable label for tool_use", () => {
    expect(statusLabel("tool_use")).toBe("Using tool");
  });
});

describe("truncate", () => {
  it("returns string unchanged when under limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello...");
    expect(result.length).toBe(8);
  });

  it("handles exact length boundary", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("formatTime", () => {
  it("formats a Date object as HH:MM:SS", () => {
    const date = new Date(2025, 0, 1, 14, 30, 45);
    const result = formatTime(date);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("accepts an ISO 8601 string", () => {
    const iso = "2025-01-01T14:30:45.000Z";
    const result = formatTime(iso);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
