// Web Audio API synthesis engine — lazy AudioContext, per-event debounce

import {
  SOUND_DEFINITIONS,
  type SoundEvent,
  type SoundDefinition,
  type OscillatorNote,
} from "./SoundDefinitions";

export type AudioContextFactory = () => AudioContext;

const DEFAULT_CONTEXT_FACTORY: AudioContextFactory = () => new AudioContext();
const DEBOUNCE_MS = 150;
const ATTACK_MS = 0.01;
const RELEASE_MS = 0.05;

export class SoundEngine {
  private context: AudioContext | null = null;
  private readonly contextFactory: AudioContextFactory;
  private volume = 1.0;
  private readonly lastPlayTime = new Map<SoundEvent, number>();

  constructor(contextFactory?: AudioContextFactory) {
    this.contextFactory = contextFactory ?? DEFAULT_CONTEXT_FACTORY;
  }

  ensureContext(): AudioContext {
    if (!this.context) {
      this.context = this.contextFactory();
    }
    return this.context;
  }

  play(event: SoundEvent): void {
    const now = Date.now();
    const lastTime = this.lastPlayTime.get(event);
    if (lastTime !== undefined && now - lastTime < DEBOUNCE_MS) {
      return;
    }
    this.lastPlayTime.set(event, now);

    const definition = SOUND_DEFINITIONS[event];
    if (!definition) return;

    this.synthesize(definition);
  }

  private synthesize(definition: SoundDefinition): void {
    const ctx = this.ensureContext();
    const masterGain = ctx.createGain();
    masterGain.gain.value = definition.masterGain * this.volume;
    masterGain.connect(ctx.destination);

    let offset = 0;
    for (const note of definition.notes) {
      this.playNote(ctx, masterGain, note, offset);
      offset += note.duration;
    }
  }

  private playNote(
    ctx: AudioContext,
    destination: GainNode,
    note: OscillatorNote,
    startOffset: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = note.waveform;
    osc.frequency.value = note.frequency;
    if (note.detune) {
      osc.detune.value = note.detune;
    }

    const envelope = ctx.createGain();
    const startTime = ctx.currentTime + startOffset;
    const endTime = startTime + note.duration;

    // ADSR envelope: attack -> sustain -> release
    envelope.gain.setValueAtTime(0, startTime);
    envelope.gain.linearRampToValueAtTime(note.gain, startTime + ATTACK_MS);
    envelope.gain.setValueAtTime(note.gain, endTime - RELEASE_MS);
    envelope.gain.linearRampToValueAtTime(0, endTime);

    osc.connect(envelope);
    envelope.connect(destination);

    osc.start(startTime);
    osc.stop(endTime + 0.01);
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
  }

  getVolume(): number {
    return this.volume;
  }

  destroy(): void {
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
    this.lastPlayTime.clear();
  }
}
