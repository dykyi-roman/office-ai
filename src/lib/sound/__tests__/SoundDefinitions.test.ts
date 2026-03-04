import { describe, it, expect } from "vitest";
import {
  SOUND_DEFINITIONS,
  STATUS_SOUND_MAP,
  type SoundEvent,
  type WaveformType,
} from "../SoundDefinitions";

const ALL_EVENTS: SoundEvent[] = [
  "agent_found",
  "agent_lost",
  "thinking",
  "responding",
  "tool_use",
  "task_complete",
  "error",
];

const VALID_WAVEFORMS: WaveformType[] = [
  "sine",
  "square",
  "sawtooth",
  "triangle",
];

describe("SOUND_DEFINITIONS", () => {
  it("has definitions for all 7 sound events", () => {
    for (const event of ALL_EVENTS) {
      expect(SOUND_DEFINITIONS[event]).toBeDefined();
    }
  });

  it("each definition has at least one note", () => {
    for (const event of ALL_EVENTS) {
      expect(SOUND_DEFINITIONS[event].notes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("all frequencies are in audible range (20-20000 Hz)", () => {
    for (const event of ALL_EVENTS) {
      for (const note of SOUND_DEFINITIONS[event].notes) {
        expect(note.frequency).toBeGreaterThanOrEqual(20);
        expect(note.frequency).toBeLessThanOrEqual(20000);
      }
    }
  });

  it("all gains are in valid range (0-1)", () => {
    for (const event of ALL_EVENTS) {
      const def = SOUND_DEFINITIONS[event];
      expect(def.masterGain).toBeGreaterThanOrEqual(0);
      expect(def.masterGain).toBeLessThanOrEqual(1);
      for (const note of def.notes) {
        expect(note.gain).toBeGreaterThanOrEqual(0);
        expect(note.gain).toBeLessThanOrEqual(1);
      }
    }
  });

  it("all durations are positive", () => {
    for (const event of ALL_EVENTS) {
      for (const note of SOUND_DEFINITIONS[event].notes) {
        expect(note.duration).toBeGreaterThan(0);
      }
    }
  });

  it("all waveforms are valid OscillatorType values", () => {
    for (const event of ALL_EVENTS) {
      for (const note of SOUND_DEFINITIONS[event].notes) {
        expect(VALID_WAVEFORMS).toContain(note.waveform);
      }
    }
  });
});

describe("STATUS_SOUND_MAP", () => {
  it("maps thinking to thinking sound", () => {
    expect(STATUS_SOUND_MAP.thinking).toBe("thinking");
  });

  it("maps responding to responding sound", () => {
    expect(STATUS_SOUND_MAP.responding).toBe("responding");
  });

  it("maps tool_use to tool_use sound", () => {
    expect(STATUS_SOUND_MAP.tool_use).toBe("tool_use");
  });

  it("maps task_complete to task_complete sound", () => {
    expect(STATUS_SOUND_MAP.task_complete).toBe("task_complete");
  });

  it("maps error to error sound", () => {
    expect(STATUS_SOUND_MAP.error).toBe("error");
  });

  it("does not map idle status", () => {
    expect(STATUS_SOUND_MAP.idle).toBeUndefined();
  });

  it("does not map walking_to_desk status", () => {
    expect(STATUS_SOUND_MAP.walking_to_desk).toBeUndefined();
  });

  it("does not map offline status", () => {
    expect(STATUS_SOUND_MAP.offline).toBeUndefined();
  });
});
