import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pixi.js", () => {
  class MockContainer {
    addChild = vi.fn();
    removeChild = vi.fn();
    removeChildren = vi.fn();
    destroy = vi.fn();
    x = 0;
    y = 0;
    zIndex = 0;
    alpha = 1;
    visible = true;
    scale = { set: vi.fn(), x: 1, y: 1 };
    pivot = { set: vi.fn() };
    width = 0;
    height = 0;
    sortableChildren = false;
  }

  class MockGraphics {
    moveTo = vi.fn().mockReturnThis();
    lineTo = vi.fn().mockReturnThis();
    closePath = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
    circle = vi.fn().mockReturnThis();
    ellipse = vi.fn().mockReturnThis();
    roundRect = vi.fn().mockReturnThis();
    clear = vi.fn().mockReturnThis();
    addChild = vi.fn();
    x = 0;
    y = 0;
    zIndex = 0;
  }

  class MockText {
    anchor = { set: vi.fn() };
    x = 0;
    y = 0;
    text = "";
    width = 60;
    height = 14;
    constructor(_opts?: unknown) {}
  }

  class MockAnimatedSprite {
    anchor = { set: vi.fn() };
    animationSpeed = 0;
    play = vi.fn();
    textures: unknown[] = [];
    playing = false;
    x = 0;
    y = 0;
    zIndex = 0;
  }

  class MockSprite {
    anchor = { set: vi.fn() };
    x = 0;
    y = 0;
    zIndex = 0;
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Text: MockText,
    TextStyle: vi.fn(),
    AnimatedSprite: MockAnimatedSprite,
    Sprite: MockSprite,
    Texture: { WHITE: { label: "white" } },
    Ticker: {
      shared: {
        add: vi.fn(),
        remove: vi.fn(),
        deltaMS: 16,
      },
    },
  };
});

vi.mock("../AnimationController", () => ({
  AnimationController: class MockAnimationController {
    transition = vi.fn();
    walkStarted = vi.fn();
    walkComplete = vi.fn();
    getStatus = vi.fn().mockReturnValue("idle");
    destroy = vi.fn();
    constructor(_parent?: unknown) {}
  },
  walkAnimationForDirection: vi.fn().mockReturnValue("walk_down"),
}));

vi.mock("../SpeechBubble", () => ({
  SpeechBubble: class MockSpeechBubble {
    show = vi.fn();
    hide = vi.fn();
    destroy = vi.fn();
    x = 0;
    y = 0;
  },
}));

import { NpcManager, type NpcConfig } from "../NpcManager";
import type { Pathfinder } from "../Pathfinder";

function makeNpcConfig(): NpcConfig {
  return {
    id: "hr_npc",
    name: "Maria",
    role: "hr",
    tier: "middle",
    homePosition: { col: 16, row: 12 },
    routines: [
      {
        targetZone: "bathroom",
        intervalMs: [60000, 180000],
        dwellMs: [10000, 20000],
      },
      {
        targetZone: "kitchen",
        intervalMs: [120000, 300000],
        dwellMs: [15000, 30000],
      },
    ],
  };
}

function makeMockPathfinder(): Pathfinder {
  return {
    findPath: vi.fn().mockReturnValue([{ col: 10, row: 12 }]),
    nearestWalkableNeighbor: vi.fn().mockReturnValue({ col: 15, row: 12 }),
    setDeskPositions: vi.fn(),
    getRandomIdlePosition: vi.fn().mockReturnValue({ col: 5, row: 5 }),
  } as unknown as Pathfinder;
}

describe("NpcManager — spawn and lifecycle", () => {
  let manager: NpcManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new NpcManager();
  });

  it("spawns NPC at homePosition", () => {
    const config = makeNpcConfig();
    const pathfinder = makeMockPathfinder();
    manager.setup(pathfinder, () => ({ col: 10, row: 12 }));

    const sprites = manager.spawnNpcs([config], () => null);

    expect(sprites).toHaveLength(1);
    expect(manager.isNpc("hr_npc")).toBe(true);

    manager.destroy();
    vi.useRealTimers();
  });

  it("getNpcSprite returns the sprite by id", () => {
    const config = makeNpcConfig();
    manager.setup(makeMockPathfinder(), () => ({ col: 10, row: 12 }));

    const sprites = manager.spawnNpcs([config], () => null);
    const sprite = manager.getNpcSprite("hr_npc");

    expect(sprite).toBeDefined();
    expect(sprite).toBe(sprites[0]);

    manager.destroy();
    vi.useRealTimers();
  });

  it("isNpc returns false for unknown id", () => {
    expect(manager.isNpc("unknown")).toBe(false);
    vi.useRealTimers();
  });

  it("destroy cleans up all NPCs", () => {
    const config = makeNpcConfig();
    manager.setup(makeMockPathfinder(), () => ({ col: 10, row: 12 }));
    manager.spawnNpcs([config], () => null);

    manager.destroy();

    expect(manager.isNpc("hr_npc")).toBe(false);
    expect(manager.getNpcSprite("hr_npc")).toBeUndefined();

    vi.useRealTimers();
  });

  it("routine triggers pathfinder after timer fires", () => {
    const config = makeNpcConfig();
    const pathfinder = makeMockPathfinder();
    manager.setup(pathfinder, () => ({ col: 10, row: 12 }));
    manager.spawnNpcs([config], () => null);

    vi.advanceTimersByTime(300_001);

    expect(pathfinder.findPath).toHaveBeenCalled();

    manager.destroy();
    vi.useRealTimers();
  });

  it("spawns multiple NPCs independently", () => {
    const config1 = makeNpcConfig();
    const config2: NpcConfig = {
      ...makeNpcConfig(),
      id: "receptionist_npc",
      name: "Alex",
      role: "receptionist",
      homePosition: { col: 1, row: 1 },
    };

    manager.setup(makeMockPathfinder(), () => ({ col: 5, row: 5 }));
    const sprites = manager.spawnNpcs([config1, config2], () => null);

    expect(sprites).toHaveLength(2);
    expect(manager.isNpc("hr_npc")).toBe(true);
    expect(manager.isNpc("receptionist_npc")).toBe(true);

    manager.destroy();
    vi.useRealTimers();
  });
});
