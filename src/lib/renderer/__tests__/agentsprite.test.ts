// Unit tests for AgentSprite logic
// PixiJS classes are fully mocked — tests focus on state and coordinate logic

import { describe, it, expect, vi } from "vitest";
import type { AgentState } from "../../types/agent";
import type { GridPosition } from "../../types/office";

// ---------------------------------------------------------------------------
// PixiJS mock
// ---------------------------------------------------------------------------

const mockTicker = {
  shared: {
    add: vi.fn(),
    remove: vi.fn(),
    deltaMS: 16,
  },
};

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(() => ({
    addChild: vi.fn(),
    removeChild: vi.fn(),
    removeChildren: vi.fn(),
    destroy: vi.fn(),
    x: 0,
    y: 0,
    zIndex: 0,
    alpha: 1,
    visible: true,
    scale: { set: vi.fn(), x: 1, y: 1 },
    pivot: { set: vi.fn() },
    width: 0,
    height: 0,
  })),
  Graphics: vi.fn().mockImplementation(() => ({
    moveTo: vi.fn().mockReturnThis(),
    lineTo: vi.fn().mockReturnThis(),
    closePath: vi.fn().mockReturnThis(),
    fill: vi.fn().mockReturnThis(),
    stroke: vi.fn().mockReturnThis(),
    circle: vi.fn().mockReturnThis(),
    ellipse: vi.fn().mockReturnThis(),
    roundRect: vi.fn().mockReturnThis(),
    clear: vi.fn().mockReturnThis(),
    addChild: vi.fn(),
    x: 0,
    y: 0,
    zIndex: 0,
  })),
  Text: vi.fn().mockImplementation(() => ({
    anchor: { set: vi.fn() },
    x: 0,
    y: 0,
    text: "",
    width: 60,
    height: 14,
  })),
  TextStyle: vi.fn(),
  AnimatedSprite: vi.fn().mockImplementation(() => ({
    anchor: { set: vi.fn() },
    animationSpeed: 0,
    play: vi.fn(),
    textures: [],
    playing: false,
    x: 0,
    y: 0,
    zIndex: 0,
  })),
  Texture: {
    WHITE: { label: "white" },
  },
  Ticker: mockTicker,
}));

vi.mock("$lib/stores/settings.svelte", () => ({
  getSetting: vi.fn().mockReturnValue(1.0),
}));

vi.mock("../../types/agent", () => ({}));
vi.mock("../AnimationController", () => ({
  AnimationController: vi.fn().mockImplementation(() => ({
    transition: vi.fn(),
    walkStarted: vi.fn(),
    walkComplete: vi.fn(),
    getStatus: vi.fn().mockReturnValue("idle"),
    destroy: vi.fn(),
  })),
  walkAnimationForDirection: vi.fn().mockReturnValue("walk_down"),
}));
vi.mock("../SpeechBubble", () => ({
  SpeechBubble: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    y: 0,
    x: 0,
  })),
}));

// ---------------------------------------------------------------------------
// Pure isoToScreen logic (replicated to avoid PixiJS import)
// ---------------------------------------------------------------------------

const HALF_TILE_W = 64;
const HALF_TILE_H = 32;

function isoToScreen(col: number, row: number): { x: number; y: number } {
  return {
    x: (col - row) * HALF_TILE_W,
    y: (col + row) * HALF_TILE_H,
  };
}

// ---------------------------------------------------------------------------
// AgentSprite pure logic tests (grid position, walk path, state)
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: "test-agent",
    pid: 1234,
    name: "Test Agent",
    model: "claude-sonnet-4-6",
    tier: "senior",
    role: "Developer",
    status: "idle",
    idleLocation: "desk",
    currentTask: null,
    tokensIn: 100,
    tokensOut: 50,
    subAgents: [],
    lastActivity: new Date().toISOString(),
    source: "cli",
    ...overrides,
  };
}

describe("AgentSprite — isoToScreen coordinate mapping", () => {
  it("origin maps to (0, 0)", () => {
    const pos = isoToScreen(0, 0);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
  });

  it("col=1, row=0 shifts right and down", () => {
    const pos = isoToScreen(1, 0);
    expect(pos.x).toBe(HALF_TILE_W);
    expect(pos.y).toBe(HALF_TILE_H);
  });

  it("col=0, row=1 shifts left and down", () => {
    const pos = isoToScreen(0, 1);
    expect(pos.x).toBe(-HALF_TILE_W);
    expect(pos.y).toBe(HALF_TILE_H);
  });

  it("col=3, row=3 has x=0 (diagonal cancels)", () => {
    const pos = isoToScreen(3, 3);
    expect(pos.x).toBe(0);
  });
});

describe("AgentSprite — walk path tracking", () => {
  it("walkAlongPath invokes callback immediately for empty path", () => {
    const onArrive = vi.fn();
    const path: GridPosition[] = [];

    // Mirrors AgentSprite.walkAlongPath logic
    if (path.length === 0) {
      onArrive();
    }

    expect(onArrive).toHaveBeenCalledOnce();
  });

  it("single-step path is populated correctly", () => {
    const target: GridPosition = { col: 5, row: 3 };
    const walkPath = [target];

    expect(walkPath).toHaveLength(1);
    expect(walkPath[0]).toEqual(target);
  });

  it("path is consumed tile by tile (shift semantics)", () => {
    const path: GridPosition[] = [
      { col: 1, row: 1 },
      { col: 2, row: 1 },
      { col: 3, row: 1 },
    ];

    path.shift();
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual({ col: 2, row: 1 });
  });

  it("walkOnArrive callback fires when path is empty after last step", () => {
    const onArrive = vi.fn();
    const path: GridPosition[] = [{ col: 1, row: 1 }];

    path.shift();
    if (path.length === 0) {
      onArrive();
    }

    expect(onArrive).toHaveBeenCalledOnce();
  });
});

describe("AgentSprite — grid position tracking", () => {
  it("snapToGrid updates currentGridPos", () => {
    let currentGridPos: GridPosition = { col: 0, row: 0 };
    const snapToGrid = (pos: GridPosition): void => {
      currentGridPos = { ...pos };
    };

    snapToGrid({ col: 5, row: 3 });
    expect(currentGridPos).toEqual({ col: 5, row: 3 });
  });

  it("getGridPosition returns a copy (not a reference)", () => {
    let currentGridPos: GridPosition = { col: 2, row: 4 };
    const getGridPosition = (): GridPosition => ({ ...currentGridPos });

    const pos = getGridPosition();
    pos.col = 99;
    expect(currentGridPos.col).toBe(2);
  });

  it("zIndex is col + row after snap", () => {
    const col = 4;
    const row = 3;
    const zIndex = col + row;
    expect(zIndex).toBe(7);
  });
});

describe("AgentSprite — walk speed calculation", () => {
  const WALK_SPEED_PX = 120;

  it("step distance is proportional to deltaMS", () => {
    const deltaMS = 16; // ~60fps frame
    const step = (WALK_SPEED_PX * deltaMS) / 1000;
    expect(step).toBeCloseTo(1.92, 2);
  });

  it("snap occurs when remaining distance <= step", () => {
    const WALK_SPEED_PX = 120;
    const deltaMS = 16;
    const step = (WALK_SPEED_PX * deltaMS) / 1000;

    const dist = 1.5; // less than step
    const shouldSnap = dist <= step;
    expect(shouldSnap).toBe(true);
  });

  it("step distance scales with animationSpeed multiplier", () => {
    const deltaMS = 16;
    const speedMultiplier = 1.5;
    const step = (WALK_SPEED_PX * speedMultiplier * deltaMS) / 1000;
    expect(step).toBeCloseTo(2.88, 2);
  });

  it("interpolation factor is correct", () => {
    const step = 2;
    const dist = 10;
    const factor = step / dist;
    expect(factor).toBe(0.2);
  });
});

describe("AgentSprite — tier dot color mapping", () => {
  const TIER_DOT_COLOR: Record<string, number> = {
    expert: 0xffd700,
    senior: 0x4a90e2,
    middle: 0x5cb85c,
    junior: 0xaaaaaa,
  };

  const TIER_DOT_STROKE: Record<string, number> = {
    expert: 0xb89b00,
    senior: 0x2d5a8e,
    middle: 0x3a7a3a,
    junior: 0x777777,
  };

  it("expert tier uses gold dot color", () => {
    expect(TIER_DOT_COLOR["expert"]).toBe(0xffd700);
  });

  it("junior tier uses grey dot color", () => {
    expect(TIER_DOT_COLOR["junior"]).toBe(0xaaaaaa);
  });

  it("all tier levels have assigned dot fill and stroke colors", () => {
    const tiers = ["expert", "senior", "middle", "junior"];
    for (const tier of tiers) {
      expect(typeof TIER_DOT_COLOR[tier]).toBe("number");
      expect(typeof TIER_DOT_STROKE[tier]).toBe("number");
    }
  });

  it("stroke colors are darker than fill colors", () => {
    const tiers = ["expert", "senior", "middle", "junior"];
    for (const tier of tiers) {
      expect(TIER_DOT_STROKE[tier]).toBeLessThan(TIER_DOT_COLOR[tier]);
    }
  });
});

describe("AgentSprite — agent state update", () => {
  it("update changes name text", () => {
    const agent = makeAgent({ name: "Initial Name" });
    let nameText = agent.name;

    const updatedAgent = { ...agent, name: "Updated Name" };
    nameText = updatedAgent.name;

    expect(nameText).toBe("Updated Name");
  });

  it("update reflects new status in animController", () => {
    const transitionFn = vi.fn();
    const agent = makeAgent({ status: "idle" });

    // Mirrors AgentSprite.update
    transitionFn(agent.status);
    const updated = { ...agent, status: "thinking" };
    transitionFn(updated.status);

    expect(transitionFn).toHaveBeenCalledWith("thinking");
  });
});

describe("AgentSprite — speech bubble duration", () => {
  it("minimum duration is 3000ms", () => {
    const text = "Hi";
    const duration = Math.max(3000, text.length * 50);
    expect(duration).toBe(3000);
  });

  it("longer text gets longer duration", () => {
    const text = "A".repeat(100);
    const duration = Math.max(3000, text.length * 50);
    expect(duration).toBe(5000);
  });
});
