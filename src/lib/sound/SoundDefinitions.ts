// Sound synthesis definitions — pure data, no side effects

import type { Status } from "$lib/types/index";

export type WaveformType = "sine" | "square" | "sawtooth" | "triangle";

export interface OscillatorNote {
  frequency: number;
  duration: number;
  waveform: WaveformType;
  gain: number;
  detune?: number;
}

export interface SoundDefinition {
  notes: OscillatorNote[];
  masterGain: number;
}

export type SoundEvent =
  | "agent_found"
  | "agent_lost"
  | "thinking"
  | "responding"
  | "tool_use"
  | "task_complete"
  | "error";

export const STATUS_SOUND_MAP: Partial<Record<Status, SoundEvent>> = {
  thinking: "thinking",
  responding: "responding",
  tool_use: "tool_use",
  task_complete: "task_complete",
  error: "error",
};

export const SOUND_DEFINITIONS: Record<SoundEvent, SoundDefinition> = {
  // Ascending 3-note major chime (C5-E5-G5)
  agent_found: {
    notes: [
      { frequency: 523.25, duration: 0.1, waveform: "square", gain: 0.4 },
      { frequency: 659.25, duration: 0.1, waveform: "square", gain: 0.35 },
      { frequency: 783.99, duration: 0.15, waveform: "square", gain: 0.3 },
    ],
    masterGain: 0.3,
  },

  // Descending sawtooth fade (A4 -> F4 -> slide down)
  agent_lost: {
    notes: [
      { frequency: 440, duration: 0.12, waveform: "sawtooth", gain: 0.3 },
      { frequency: 349.23, duration: 0.12, waveform: "sawtooth", gain: 0.25 },
      { frequency: 261.63, duration: 0.2, waveform: "sawtooth", gain: 0.15 },
    ],
    masterGain: 0.3,
  },

  // Soft detuned sine hum (220/227 Hz beat frequency)
  thinking: {
    notes: [
      { frequency: 220, duration: 0.25, waveform: "sine", gain: 0.2 },
      {
        frequency: 220,
        duration: 0.25,
        waveform: "sine",
        gain: 0.15,
        detune: 50,
      },
    ],
    masterGain: 0.3,
  },

  // Quick bright blip (880 -> 1047 Hz)
  responding: {
    notes: [
      { frequency: 880, duration: 0.06, waveform: "square", gain: 0.25 },
      { frequency: 1046.5, duration: 0.08, waveform: "square", gain: 0.2 },
    ],
    masterGain: 0.3,
  },

  // Two staccato clicks (800/600 Hz)
  tool_use: {
    notes: [
      { frequency: 800, duration: 0.04, waveform: "square", gain: 0.3 },
      { frequency: 600, duration: 0.04, waveform: "square", gain: 0.25 },
    ],
    masterGain: 0.3,
  },

  // Success jingle (G5-B5-D6)
  task_complete: {
    notes: [
      { frequency: 783.99, duration: 0.1, waveform: "square", gain: 0.35 },
      { frequency: 987.77, duration: 0.1, waveform: "square", gain: 0.3 },
      { frequency: 1174.66, duration: 0.15, waveform: "square", gain: 0.25 },
    ],
    masterGain: 0.3,
  },

  // Dissonant sawtooth buzz (tritone: E4 + Bb4)
  error: {
    notes: [
      { frequency: 329.63, duration: 0.2, waveform: "sawtooth", gain: 0.3 },
      { frequency: 466.16, duration: 0.2, waveform: "sawtooth", gain: 0.3 },
    ],
    masterGain: 0.3,
  },
};
