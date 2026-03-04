import { describe, it, expect } from "vitest";
import type { Status } from "$lib/types/index";
import { STATUS_SOUND_MAP, type SoundEvent } from "../SoundDefinitions";

// Pure logic tests for status transition → sound mapping
// (Bridge module uses Tauri events + Svelte stores which require runtime)

function resolveSound(
  previousStatus: Status | undefined,
  currentStatus: Status,
): SoundEvent | null {
  if (previousStatus === currentStatus) return null;
  return STATUS_SOUND_MAP[currentStatus] ?? null;
}

describe("Status transition to sound mapping", () => {
  it("returns thinking sound when transitioning to thinking", () => {
    expect(resolveSound("idle", "thinking")).toBe("thinking");
  });

  it("returns responding sound when transitioning to responding", () => {
    expect(resolveSound("thinking", "responding")).toBe("responding");
  });

  it("returns tool_use sound when transitioning to tool_use", () => {
    expect(resolveSound("thinking", "tool_use")).toBe("tool_use");
  });

  it("returns task_complete sound when transitioning to task_complete", () => {
    expect(resolveSound("responding", "task_complete")).toBe("task_complete");
  });

  it("returns error sound when transitioning to error", () => {
    expect(resolveSound("thinking", "error")).toBe("error");
  });

  it("returns null for same status (dedup)", () => {
    expect(resolveSound("thinking", "thinking")).toBeNull();
    expect(resolveSound("responding", "responding")).toBeNull();
    expect(resolveSound("tool_use", "tool_use")).toBeNull();
  });

  it("returns null for idle status", () => {
    expect(resolveSound("thinking", "idle")).toBeNull();
  });

  it("returns null for walking_to_desk status", () => {
    expect(resolveSound("idle", "walking_to_desk")).toBeNull();
  });

  it("returns null for offline status", () => {
    expect(resolveSound("idle", "offline")).toBeNull();
  });

  it("returns null for collaboration status", () => {
    expect(resolveSound("idle", "collaboration")).toBeNull();
  });

  it("handles first status (no previous) correctly", () => {
    expect(resolveSound(undefined, "thinking")).toBe("thinking");
    expect(resolveSound(undefined, "idle")).toBeNull();
  });

  it("plays sound on every distinct transition", () => {
    expect(resolveSound("idle", "thinking")).toBe("thinking");
    expect(resolveSound("thinking", "responding")).toBe("responding");
    expect(resolveSound("responding", "tool_use")).toBe("tool_use");
    expect(resolveSound("tool_use", "task_complete")).toBe("task_complete");
  });
});
