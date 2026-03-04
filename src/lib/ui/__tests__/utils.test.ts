// Comprehensive unit tests for src/lib/ui/utils.ts
// Covers all exported functions including uptimeFromLastActivity

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTokens,
  formatUptime,
  statusColor,
  tierColor,
  statusLabel,
  truncate,
  formatTime,
  uptimeFromLastActivity,
} from "../utils";

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens — small values", () => {
  it("renders 0 as '0'", () => {
    expect(formatTokens(0)).toBe("0");
  });

  it("renders 999 as '999' (below 1K boundary)", () => {
    expect(formatTokens(999)).toBe("999");
  });

  it("renders 1 as '1'", () => {
    expect(formatTokens(1)).toBe("1");
  });
});

describe("formatTokens — thousands", () => {
  it("renders 1000 as '1.0K'", () => {
    expect(formatTokens(1000)).toBe("1.0K");
  });

  it("renders 1234 as '1.2K'", () => {
    expect(formatTokens(1234)).toBe("1.2K");
  });

  it("renders 45200 as '45.2K'", () => {
    expect(formatTokens(45200)).toBe("45.2K");
  });

  it("renders 999999 as '1000.0K'", () => {
    expect(formatTokens(999_999)).toBe("1000.0K");
  });
});

describe("formatTokens — millions", () => {
  it("renders 1_000_000 as '1.0M'", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });

  it("renders 1_234_567 as '1.2M'", () => {
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  it("renders 12_500_000 as '12.5M'", () => {
    expect(formatTokens(12_500_000)).toBe("12.5M");
  });
});

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe("formatUptime — seconds only", () => {
  it("formats 0 seconds as '0s'", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("formats 45 seconds as '45s'", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats 59 seconds as '59s'", () => {
    expect(formatUptime(59)).toBe("59s");
  });
});

describe("formatUptime — minutes and seconds", () => {
  it("formats 60 seconds as '1m 0s'", () => {
    expect(formatUptime(60)).toBe("1m 0s");
  });

  it("formats 154 seconds as '2m 34s'", () => {
    expect(formatUptime(154)).toBe("2m 34s");
  });

  it("formats 3599 seconds as '59m 59s'", () => {
    expect(formatUptime(3599)).toBe("59m 59s");
  });
});

describe("formatUptime — hours and minutes", () => {
  it("formats 3600 seconds as '1h 0m'", () => {
    expect(formatUptime(3600)).toBe("1h 0m");
  });

  it("formats 9000 seconds as '2h 30m'", () => {
    expect(formatUptime(9000)).toBe("2h 30m");
  });

  it("formats 86399 seconds as '23h 59m'", () => {
    expect(formatUptime(86399)).toBe("23h 59m");
  });
});

// ---------------------------------------------------------------------------
// statusColor
// ---------------------------------------------------------------------------

describe("statusColor — all statuses have valid CSS color", () => {
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

  for (const status of statuses) {
    it(`statusColor('${status}') returns a hex CSS string`, () => {
      const color = statusColor(status);
      expect(typeof color).toBe("string");
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    });
  }
});

describe("statusColor — specific values", () => {
  it("idle is gray (#888888)", () => {
    expect(statusColor("idle")).toBe("#888888");
  });

  it("thinking is yellow (#eab308)", () => {
    expect(statusColor("thinking")).toBe("#eab308");
  });

  it("responding is green (#22c55e)", () => {
    expect(statusColor("responding")).toBe("#22c55e");
  });

  it("error is red (#ef4444)", () => {
    expect(statusColor("error")).toBe("#ef4444");
  });

  it("offline is dark (#374151)", () => {
    expect(statusColor("offline")).toBe("#374151");
  });

  it("all statuses produce distinct colors", () => {
    const colors = [
      statusColor("idle"),
      statusColor("walking_to_desk"),
      statusColor("thinking"),
      statusColor("responding"),
      statusColor("tool_use"),
      statusColor("collaboration"),
      statusColor("task_complete"),
      statusColor("error"),
      statusColor("offline"),
    ];
    const unique = new Set(colors);
    expect(unique.size).toBe(colors.length);
  });
});

// ---------------------------------------------------------------------------
// tierColor
// ---------------------------------------------------------------------------

describe("tierColor — all tiers", () => {
  it("flagship returns gold (#ffd700)", () => {
    expect(tierColor("flagship")).toBe("#ffd700");
  });

  it("senior returns blue (#4a9eff)", () => {
    expect(tierColor("senior")).toBe("#4a9eff");
  });

  it("middle returns green (#22c55e)", () => {
    expect(tierColor("middle")).toBe("#22c55e");
  });

  it("junior returns orange (#f97316)", () => {
    expect(tierColor("junior")).toBe("#f97316");
  });

  it("all tier colors are valid hex CSS strings", () => {
    const tiers = ["flagship", "senior", "middle", "junior"] as const;
    for (const tier of tiers) {
      expect(tierColor(tier)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// ---------------------------------------------------------------------------
// statusLabel
// ---------------------------------------------------------------------------

describe("statusLabel — human-readable labels", () => {
  it("idle → 'Idle'", () => {
    expect(statusLabel("idle")).toBe("Idle");
  });

  it("walking_to_desk → 'Walking to desk'", () => {
    expect(statusLabel("walking_to_desk")).toBe("Walking to desk");
  });

  it("thinking → 'Thinking...'", () => {
    expect(statusLabel("thinking")).toBe("Thinking...");
  });

  it("responding → 'Responding'", () => {
    expect(statusLabel("responding")).toBe("Responding");
  });

  it("tool_use → 'Using tool'", () => {
    expect(statusLabel("tool_use")).toBe("Using tool");
  });

  it("collaboration → 'Collaborating'", () => {
    expect(statusLabel("collaboration")).toBe("Collaborating");
  });

  it("task_complete → 'Task complete'", () => {
    expect(statusLabel("task_complete")).toBe("Task complete");
  });

  it("error → 'Error'", () => {
    expect(statusLabel("error")).toBe("Error");
  });

  it("offline → 'Offline'", () => {
    expect(statusLabel("offline")).toBe("Offline");
  });

  it("all statuses return non-empty strings", () => {
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

    for (const s of statuses) {
      const label = statusLabel(s);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns string unchanged when shorter than limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns string unchanged when equal to limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello...");
    expect(result.length).toBe(8);
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });

  it("limit of 3 produces only '...'", () => {
    expect(truncate("abcdef", 3)).toBe("...");
  });
});

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

describe("formatTime", () => {
  it("formats a Date object as HH:MM:SS", () => {
    const date = new Date(2025, 0, 15, 10, 5, 3);
    expect(formatTime(date)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("accepts an ISO 8601 string", () => {
    const result = formatTime("2025-06-01T14:30:45.000Z");
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("returns 8-character time string", () => {
    const result = formatTime(new Date());
    expect(result.length).toBe(8);
  });

  it("contains colons as separators", () => {
    const result = formatTime(new Date(2025, 5, 1, 9, 8, 7));
    const parts = result.split(":");
    expect(parts).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// uptimeFromLastActivity
// ---------------------------------------------------------------------------

describe("uptimeFromLastActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 for invalid ISO string", () => {
    expect(uptimeFromLastActivity("not-a-date")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(uptimeFromLastActivity("")).toBe(0);
  });

  it("returns uptime in seconds since last activity", () => {
    const now = new Date("2025-06-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const uptime = uptimeFromLastActivity(fiveMinutesAgo);
    expect(uptime).toBe(300);
  });

  it("returns positive value for past timestamps", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    vi.setSystemTime(now);

    const tenSecondsAgo = new Date(now.getTime() - 10_000).toISOString();
    const result = uptimeFromLastActivity(tenSecondsAgo);
    expect(result).toBe(10);
  });

  it("floors fractional seconds", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    vi.setSystemTime(now);

    const almostTwoSeconds = new Date(now.getTime() - 1999).toISOString();
    expect(uptimeFromLastActivity(almostTwoSeconds)).toBe(1);
  });
});
