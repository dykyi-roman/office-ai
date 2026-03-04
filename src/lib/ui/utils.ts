// UI utility functions for formatting and color mapping

import type { Status, Tier } from "$lib/types/index";
import { t } from "$lib/i18n/index";
import type { TranslationKey } from "$lib/i18n/translations";

/**
 * Format a token count into a compact human-readable string.
 * Examples: 1234 → "1.2K", 1234567 → "1.2M", 500 → "500"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

/**
 * Format uptime in seconds into a human-readable string.
 * Examples: 154 → "2m 34s", 9000 → "2h 30m"
 */
export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

/**
 * Map agent status to a CSS color string.
 */
export function statusColor(status: Status): string {
  switch (status) {
    case "idle":
      return "#888888";
    case "walking_to_desk":
      return "#60a5fa";
    case "thinking":
      return "#eab308";
    case "responding":
      return "#22c55e";
    case "tool_use":
      return "#a78bfa";
    case "collaboration":
      return "#38bdf8";
    case "task_complete":
      return "#4ade80";
    case "error":
      return "#ef4444";
    case "offline":
      return "#374151";
  }
}

/**
 * Map agent tier to a CSS color string.
 */
export function tierColor(tier: Tier): string {
  switch (tier) {
    case "flagship":
      return "#ffd700";
    case "senior":
      return "#4a9eff";
    case "middle":
      return "#22c55e";
    case "junior":
      return "#f97316";
  }
}

/**
 * Map agent status to a human-readable label (localized).
 */
export function statusLabel(status: Status): string {
  const key = `status.${status}` as TranslationKey;
  return t(key);
}

/**
 * Truncate a string to a maximum length with an ellipsis.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Format a Date or ISO 8601 string as HH:MM:SS.
 */
export function formatTime(dateOrIso: Date | string): string {
  const date = typeof dateOrIso === "string" ? new Date(dateOrIso) : dateOrIso;
  return date.toTimeString().slice(0, 8);
}

/**
 * Compute uptime in seconds from a lastActivity ISO 8601 string.
 * Returns 0 if the date is invalid.
 */
export function uptimeFromLastActivity(lastActivity: string): number {
  const start = new Date(lastActivity).getTime();
  if (isNaN(start)) return 0;
  return Math.floor((Date.now() - start) / 1000);
}
