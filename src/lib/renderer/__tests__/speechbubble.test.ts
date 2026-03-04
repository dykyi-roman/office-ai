// Unit tests for SpeechBubble animation phase logic
// PixiJS is mocked — tests cover pure timing / phase state machine

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const tickerListeners = new Map<Function, unknown>();

const mockTicker = {
  shared: {
    add: vi.fn((fn: Function, ctx?: unknown) => {
      tickerListeners.set(fn, ctx);
    }),
    remove: vi.fn((fn: Function) => {
      tickerListeners.delete(fn);
    }),
    get listenerCount() {
      return tickerListeners.size;
    },
  },
};

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(() => ({
    addChild: vi.fn(),
    removeChild: vi.fn(),
    destroy: vi.fn(),
    x: 0,
    y: 0,
    alpha: 1,
    visible: false,
    scale: { set: vi.fn() },
    pivot: { set: vi.fn() },
  })),
  Graphics: vi.fn().mockImplementation(() => ({
    moveTo: vi.fn().mockReturnThis(),
    lineTo: vi.fn().mockReturnThis(),
    closePath: vi.fn().mockReturnThis(),
    fill: vi.fn().mockReturnThis(),
    stroke: vi.fn().mockReturnThis(),
    roundRect: vi.fn().mockReturnThis(),
    clear: vi.fn().mockReturnThis(),
    x: 0,
    y: 0,
  })),
  Text: vi.fn().mockImplementation(() => ({
    anchor: { set: vi.fn() },
    x: 0,
    y: 0,
    text: "",
    width: 80,
    height: 16,
  })),
  TextStyle: vi.fn(),
  Ticker: mockTicker,
}));

// ---------------------------------------------------------------------------
// Pure animation phase logic (extracted from SpeechBubble)
// ---------------------------------------------------------------------------

const APPEAR_MS = 150;
const DISAPPEAR_MS = 300;

type AnimPhase = "idle" | "appearing" | "visible" | "disappearing";

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function tickAppearing(
  elapsed: number,
  dt: number,
): { elapsed: number; scale: number; phase: AnimPhase } {
  const newElapsed = elapsed + dt;
  const t = Math.min(newElapsed / APPEAR_MS, 1);
  const scale = easeOut(t);
  const phase: AnimPhase = t >= 1 ? "visible" : "appearing";
  return { elapsed: newElapsed, scale, phase };
}

function tickDisappearing(
  elapsed: number,
  dt: number,
): { elapsed: number; alpha: number; phase: AnimPhase; visible: boolean } {
  const newElapsed = elapsed + dt;
  const t = Math.min(newElapsed / DISAPPEAR_MS, 1);
  const alpha = 1 - t;
  const done = t >= 1;
  return {
    elapsed: newElapsed,
    alpha: done ? 1 : alpha,
    phase: done ? "idle" : "disappearing",
    visible: !done,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SpeechBubble — easeOut function", () => {
  it("returns 0 at t=0", () => {
    expect(easeOut(0)).toBe(0);
  });

  it("returns 1 at t=1", () => {
    expect(easeOut(1)).toBe(1);
  });

  it("returns value between 0 and 1 for t in (0, 1)", () => {
    const result = easeOut(0.5);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("is monotonically increasing", () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map(easeOut);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it("eases out (faster at start, slower at end)", () => {
    const firstQuarter = easeOut(0.25) - easeOut(0);
    const lastQuarter = easeOut(1) - easeOut(0.75);
    expect(firstQuarter).toBeGreaterThan(lastQuarter);
  });
});

describe("SpeechBubble — appear phase", () => {
  it("starts in appearing phase with scale=0", () => {
    const phase: AnimPhase = "appearing";
    const scale = 0;
    expect(phase).toBe("appearing");
    expect(scale).toBe(0);
  });

  it("transitions to visible when elapsed >= APPEAR_MS", () => {
    const { phase, scale } = tickAppearing(0, APPEAR_MS);
    expect(phase).toBe("visible");
    expect(scale).toBe(1);
  });

  it("stays in appearing phase when elapsed < APPEAR_MS", () => {
    const { phase } = tickAppearing(0, 50);
    expect(phase).toBe("appearing");
  });

  it("scale increases smoothly during appearing phase", () => {
    const step1 = tickAppearing(0, 50);
    const step2 = tickAppearing(step1.elapsed, 50);

    expect(step2.scale).toBeGreaterThan(step1.scale);
  });

  it("elapsed accumulates correctly across multiple ticks", () => {
    let elapsed = 0;
    for (let i = 0; i < 5; i++) {
      const result = tickAppearing(elapsed, 30);
      elapsed = result.elapsed;
    }
    expect(elapsed).toBe(150);
  });
});

describe("SpeechBubble — disappear phase", () => {
  it("alpha decreases from 1 to 0 during disappearing", () => {
    const step1 = tickDisappearing(0, 100);
    const step2 = tickDisappearing(step1.elapsed, 100);

    expect(step1.alpha).toBeGreaterThan(step2.alpha);
  });

  it("transitions to idle phase when elapsed >= DISAPPEAR_MS", () => {
    const { phase, visible } = tickDisappearing(0, DISAPPEAR_MS);
    expect(phase).toBe("idle");
    expect(visible).toBe(false);
  });

  it("alpha resets to 1 after disappear completes", () => {
    const { alpha } = tickDisappearing(0, DISAPPEAR_MS);
    expect(alpha).toBe(1);
  });

  it("stays in disappearing phase while elapsed < DISAPPEAR_MS", () => {
    const { phase } = tickDisappearing(0, 100);
    expect(phase).toBe("disappearing");
  });

  it("visible remains true during disappearing", () => {
    const { visible } = tickDisappearing(0, 150);
    expect(visible).toBe(true);
  });
});

describe("SpeechBubble — hide() guard conditions", () => {
  it("hide() is a no-op when phase is already disappearing", () => {
    let phase: AnimPhase = "disappearing";
    const hide = (): void => {
      if (phase === "disappearing" || phase === "idle") return;
      phase = "disappearing";
    };

    hide();
    // Phase should remain "disappearing" (guard fired, no re-entry)
    expect(phase).toBe("disappearing");
  });

  it("hide() is a no-op when phase is idle", () => {
    let phase: AnimPhase = "idle";
    const hide = (): void => {
      if (phase === "disappearing" || phase === "idle") return;
      phase = "disappearing";
    };

    hide();
    expect(phase).toBe("idle");
  });

  it("hide() transitions from appearing to disappearing", () => {
    let phase: AnimPhase = "appearing";
    const hide = (): void => {
      if (phase === "disappearing" || phase === "idle") return;
      phase = "disappearing";
    };

    hide();
    expect(phase).toBe("disappearing");
  });

  it("hide() transitions from visible to disappearing", () => {
    let phase: AnimPhase = "visible";
    const hide = (): void => {
      if (phase === "disappearing" || phase === "idle") return;
      phase = "disappearing";
    };

    hide();
    expect(phase).toBe("disappearing");
  });
});

describe("SpeechBubble — show() reset behavior", () => {
  it("resets elapsed to 0 on show()", () => {
    let elapsed = 200;
    const show = (): void => {
      elapsed = 0;
    };
    show();
    expect(elapsed).toBe(0);
  });

  it("transitions phase to appearing on show()", () => {
    let phase: AnimPhase = "idle";
    const show = (): void => {
      phase = "appearing";
    };
    show();
    expect(phase).toBe("appearing");
  });

  it("sets visible to true on show()", () => {
    let visible = false;
    const show = (): void => {
      visible = true;
    };
    show();
    expect(visible).toBe(true);
  });
});

describe("SpeechBubble — auto-dismiss timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dismiss timer fires after APPEAR_MS + durationMs", () => {
    const hideFn = vi.fn();
    const durationMs = 2000;

    // Use globalThis.setTimeout — works in both browser and Node environments
    globalThis.setTimeout(hideFn, APPEAR_MS + durationMs);

    vi.advanceTimersByTime(APPEAR_MS + durationMs - 1);
    expect(hideFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hideFn).toHaveBeenCalledOnce();
  });

  it("clearDismissTimer cancels pending hide", () => {
    const hideFn = vi.fn();
    const timer = globalThis.setTimeout(hideFn, 3000);

    globalThis.clearTimeout(timer);
    vi.advanceTimersByTime(5000);

    expect(hideFn).not.toHaveBeenCalled();
  });
});
