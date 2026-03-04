import { describe, it, expect, vi, beforeEach } from "vitest";
import { SoundEngine } from "../SoundEngine";

function createMockOscillator() {
  return {
    type: "sine" as OscillatorType,
    frequency: { value: 0 },
    detune: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockGainNode() {
  return {
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
}

function createMockAudioContext() {
  const ctx = {
    currentTime: 0,
    destination: {},
    createOscillator: vi.fn(() => createMockOscillator()),
    createGain: vi.fn(() => createMockGainNode()),
    close: vi.fn(() => Promise.resolve()),
  };
  return ctx as unknown as AudioContext;
}

describe("SoundEngine", () => {
  let mockCtx: AudioContext;
  let engine: SoundEngine;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
    engine = new SoundEngine(() => mockCtx);
  });

  describe("ensureContext", () => {
    it("creates AudioContext lazily on first call", () => {
      const factory = vi.fn(() => mockCtx);
      const eng = new SoundEngine(factory);

      expect(factory).not.toHaveBeenCalled();
      eng.ensureContext();
      expect(factory).toHaveBeenCalledOnce();
    });

    it("reuses existing context on subsequent calls", () => {
      const factory = vi.fn(() => mockCtx);
      const eng = new SoundEngine(factory);

      eng.ensureContext();
      eng.ensureContext();
      expect(factory).toHaveBeenCalledOnce();
    });
  });

  describe("play", () => {
    it("creates oscillator and gain nodes for each note", () => {
      engine.play("agent_found");

      expect(mockCtx.createOscillator).toHaveBeenCalled();
      expect(mockCtx.createGain).toHaveBeenCalled();
    });

    it("debounces same event within 150ms", () => {
      engine.play("agent_found");
      const callCount = (mockCtx.createOscillator as ReturnType<typeof vi.fn>)
        .mock.calls.length;

      engine.play("agent_found");
      expect(
        (mockCtx.createOscillator as ReturnType<typeof vi.fn>).mock.calls
          .length,
      ).toBe(callCount);
    });

    it("allows different events without debounce", () => {
      engine.play("agent_found");
      const callsAfterFirst = (
        mockCtx.createOscillator as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      engine.play("agent_lost");
      expect(
        (mockCtx.createOscillator as ReturnType<typeof vi.fn>).mock.calls
          .length,
      ).toBeGreaterThan(callsAfterFirst);
    });

    it("allows same event after debounce period", () => {
      vi.useFakeTimers();

      engine.play("agent_found");
      const callsAfterFirst = (
        mockCtx.createOscillator as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      vi.advanceTimersByTime(200);
      engine.play("agent_found");
      expect(
        (mockCtx.createOscillator as ReturnType<typeof vi.fn>).mock.calls
          .length,
      ).toBeGreaterThan(callsAfterFirst);

      vi.useRealTimers();
    });
  });

  describe("setVolume", () => {
    it("clamps volume to 0-1 range", () => {
      engine.setVolume(-0.5);
      expect(engine.getVolume()).toBe(0);

      engine.setVolume(1.5);
      expect(engine.getVolume()).toBe(1);

      engine.setVolume(0.7);
      expect(engine.getVolume()).toBe(0.7);
    });
  });

  describe("destroy", () => {
    it("closes AudioContext and clears state", () => {
      engine.ensureContext();
      engine.play("agent_found");
      engine.destroy();

      expect(mockCtx.close).toHaveBeenCalledOnce();
    });

    it("is safe to call when no context exists", () => {
      expect(() => engine.destroy()).not.toThrow();
    });

    it("allows re-creation after destroy", () => {
      const factory = vi.fn(() => createMockAudioContext() as AudioContext);
      const eng = new SoundEngine(factory);

      eng.ensureContext();
      eng.destroy();
      eng.ensureContext();

      expect(factory).toHaveBeenCalledTimes(2);
    });
  });
});
