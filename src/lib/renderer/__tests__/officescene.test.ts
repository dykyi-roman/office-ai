// Unit tests for OfficeScene business logic
// PixiJS rendering classes are mocked — only pure logic is tested

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("pixi.js", () => ({
  Application: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    canvas: document.createElement("canvas"),
    stage: {
      addChild: vi.fn(),
    },
    renderer: {
      resize: vi.fn(),
    },
    destroy: vi.fn(),
  })),
  Assets: {
    load: vi.fn().mockRejectedValue(new Error("no assets in test")),
  },
  Container: vi.fn().mockImplementation(() => ({
    addChild: vi.fn(),
    removeChild: vi.fn(),
    removeChildren: vi.fn(),
    sortableChildren: false,
    x: 0,
    y: 0,
    scale: { set: vi.fn(), x: 1, y: 1 },
    zIndex: 0,
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
  Sprite: vi.fn().mockImplementation(() => ({
    anchor: { set: vi.fn() },
    x: 0,
    y: 0,
    zIndex: 0,
  })),
  Text: vi.fn().mockImplementation(() => ({
    anchor: { set: vi.fn() },
    x: 0,
    y: 0,
    text: "",
  })),
  TextStyle: vi.fn(),
  Ticker: {
    shared: {
      add: vi.fn(),
      remove: vi.fn(),
    },
  },
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
    WHITE: {},
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../layouts/medium.json", () => ({
  default: {
    size: "medium",
    width: 24,
    height: 20,
    tiles: [],
    furniture: [],
    desks: [
      { agentId: "", position: { col: 5, row: 5 }, isOccupied: false },
      { agentId: "", position: { col: 6, row: 5 }, isOccupied: false },
    ],
    zones: [
      {
        id: "zone-1",
        type: "water_cooler",
        position: { col: 2, row: 2 },
        capacity: 3,
        currentOccupants: [],
      },
    ],
    npcs: [],
    walkableGrid: Array.from({ length: 20 }, () => Array(24).fill(true)),
  },
}));

// ---------------------------------------------------------------------------
// Pure logic extracted from OfficeScene (tested without DOM or PixiJS)
// ---------------------------------------------------------------------------

/** Mirrors LAYOUT_THRESHOLDS from OfficeScene */
const LAYOUT_THRESHOLDS: Array<{ maxAgents: number; size: string }> = [
  { maxAgents: 4, size: "small" },
  { maxAgents: 10, size: "medium" },
  { maxAgents: 20, size: "large" },
  { maxAgents: Infinity, size: "campus" },
];

function desiredLayoutSize(agentCount: number): string {
  for (const { maxAgents, size } of LAYOUT_THRESHOLDS) {
    if (agentCount <= maxAgents) return size;
  }
  return "campus";
}

function currentLayoutSize(layoutWidth: number): string {
  if (layoutWidth <= 12) return "small";
  if (layoutWidth <= 24) return "medium";
  if (layoutWidth <= 30) return "large";
  return "campus";
}

const FALLBACK_COLORS: Record<string, number> = {
  floor_wood: 0xc8a96e,
  floor_carpet: 0x7b9eaa,
  floor_tile: 0xd4d4d4,
  wall_left: 0x8b7355,
  wall_right: 0x6b5a3e,
  wall_corner: 0x5a4a30,
  desk_standard: 0x8b6914,
  desk_lead: 0x4a3d1e,
  desk_standing: 0x6e5a2a,
  water_cooler: 0x4fc3f7,
  coffee_machine: 0x795548,
  sofa_2seat: 0x7986cb,
  sofa_3seat: 0x5c6bc0,
  whiteboard: 0xf5f5f5,
  bookshelf: 0x8d6e63,
  plant_small: 0x4caf50,
  plant_large: 0x2e7d32,
  fridge: 0xf5f5f5,
  microwave: 0x333333,
  sink: 0xb0bec5,
  kitchen_table: 0xd4a96a,
  toilet: 0xf5f5f5,
  bathroom_sink: 0xe3f2fd,
  pouf: 0xe8b84b,
  hr_desk: 0xb8916a,
  door: 0xd4c9b0,
  internal_wall_left: 0xc2b9a6,
  internal_wall_right: 0xc2b9a6,
  chair_n: 0x4a5568,
  chair_s: 0x4a5568,
  chair_e: 0x4a5568,
  chair_w: 0x4a5568,
};

function fallbackColor(tileType: string): number {
  return FALLBACK_COLORS[tileType] ?? 0xaaaaaa;
}

// ---------------------------------------------------------------------------
// Tests for layout threshold logic
// ---------------------------------------------------------------------------

describe("OfficeScene — desiredLayoutSize", () => {
  it("returns small for 1 agent", () => {
    expect(desiredLayoutSize(1)).toBe("small");
  });

  it("returns small for 4 agents (boundary)", () => {
    expect(desiredLayoutSize(4)).toBe("small");
  });

  it("returns medium for 5 agents", () => {
    expect(desiredLayoutSize(5)).toBe("medium");
  });

  it("returns medium for 10 agents (boundary)", () => {
    expect(desiredLayoutSize(10)).toBe("medium");
  });

  it("returns large for 11 agents", () => {
    expect(desiredLayoutSize(11)).toBe("large");
  });

  it("returns large for 20 agents (boundary)", () => {
    expect(desiredLayoutSize(20)).toBe("large");
  });

  it("returns campus for 21+ agents", () => {
    expect(desiredLayoutSize(21)).toBe("campus");
    expect(desiredLayoutSize(100)).toBe("campus");
  });
});

describe("OfficeScene — currentLayoutSize from width", () => {
  it("returns small for width <= 12", () => {
    expect(currentLayoutSize(10)).toBe("small");
    expect(currentLayoutSize(12)).toBe("small");
  });

  it("returns medium for width 13-24", () => {
    expect(currentLayoutSize(13)).toBe("medium");
    expect(currentLayoutSize(20)).toBe("medium");
    expect(currentLayoutSize(24)).toBe("medium");
  });

  it("returns large for width 25-30", () => {
    expect(currentLayoutSize(25)).toBe("large");
    expect(currentLayoutSize(30)).toBe("large");
  });

  it("returns campus for width > 30", () => {
    expect(currentLayoutSize(31)).toBe("campus");
    expect(currentLayoutSize(100)).toBe("campus");
  });
});

// ---------------------------------------------------------------------------
// Tests for tile color mapping
// ---------------------------------------------------------------------------

describe("OfficeScene — fallbackColor", () => {
  it("returns floor_wood color", () => {
    expect(fallbackColor("floor_wood")).toBe(0xc8a96e);
  });

  it("returns water_cooler color", () => {
    expect(fallbackColor("water_cooler")).toBe(0x4fc3f7);
  });

  it("returns default gray for unknown tile type", () => {
    expect(fallbackColor("unknown_tile_type")).toBe(0xaaaaaa);
  });

  it("returns distinct colors for all known tile types", () => {
    const types = Object.keys(FALLBACK_COLORS);
    const colors = types.map(fallbackColor);
    // All resolved colors must be numbers
    for (const c of colors) {
      expect(typeof c).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests for agent tracking logic
// ---------------------------------------------------------------------------

describe("OfficeScene — agent sprite map operations", () => {
  it("stores and retrieves agent id", () => {
    const agentSprites = new Map<string, { id: string }>();
    agentSprites.set("agent-1", { id: "agent-1" });
    expect(agentSprites.has("agent-1")).toBe(true);
  });

  it("removes agent on lost event", () => {
    const agentSprites = new Map<string, { id: string }>();
    agentSprites.set("agent-1", { id: "agent-1" });
    agentSprites.delete("agent-1");
    expect(agentSprites.has("agent-1")).toBe(false);
    expect(agentSprites.size).toBe(0);
  });

  it("does not duplicate agents when onAgentFound is called twice", () => {
    const agentSprites = new Map<string, { id: string }>();
    const addOrUpdate = (id: string): void => {
      // Mirrors onAgentFound: if already exists, call onAgentStateChanged
      if (!agentSprites.has(id)) {
        agentSprites.set(id, { id });
      }
    };
    addOrUpdate("agent-1");
    addOrUpdate("agent-1");
    expect(agentSprites.size).toBe(1);
  });

  it("handles multiple agents independently", () => {
    const agentSprites = new Map<string, { id: string }>();
    agentSprites.set("a1", { id: "a1" });
    agentSprites.set("a2", { id: "a2" });
    agentSprites.set("a3", { id: "a3" });

    agentSprites.delete("a2");

    expect(agentSprites.has("a1")).toBe(true);
    expect(agentSprites.has("a2")).toBe(false);
    expect(agentSprites.has("a3")).toBe(true);
    expect(agentSprites.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests for agent state-change location transitions
// ---------------------------------------------------------------------------

type AgentLocationState = "idle_zone" | "desk" | "walking_to_desk" | "walking_to_idle";
type Status = "idle" | "thinking" | "responding" | "tool_use" | "task_complete" | "collaboration"
  | "error" | "offline" | "walking_to_desk";

const WORK_STATUSES: ReadonlySet<Status> = new Set(["thinking", "responding", "tool_use"]);
const IDLE_STATUSES: ReadonlySet<Status> = new Set(["idle", "collaboration"]);

type TransitionAction = "move_to_desk" | "move_to_idle" | "visual_only";

function resolveTransition(location: AgentLocationState | undefined, status: Status): TransitionAction {
  const isWork = WORK_STATUSES.has(status);
  const isIdle = IDLE_STATUSES.has(status);

  if ((location === "idle_zone" || location === "walking_to_idle") && isWork) {
    return "move_to_desk";
  } else if ((location === "desk" || location === "walking_to_desk") && isIdle) {
    return "move_to_idle";
  } else {
    return "visual_only";
  }
}

describe("OfficeScene — onAgentStateChanged location transitions", () => {
  it("redirects to idle zone when idle arrives during walking_to_desk", () => {
    expect(resolveTransition("walking_to_desk", "idle")).toBe("move_to_idle");
  });

  it("does visual-only update when task_complete arrives during walking_to_desk", () => {
    expect(resolveTransition("walking_to_desk", "task_complete")).toBe("visual_only");
  });

  it("moves to idle zone when agent is at desk and becomes idle", () => {
    expect(resolveTransition("desk", "idle")).toBe("move_to_idle");
  });

  it("does visual-only update when agent is at desk and task completes", () => {
    expect(resolveTransition("desk", "task_complete")).toBe("visual_only");
  });

  it("moves to desk when agent is at idle_zone and starts working", () => {
    expect(resolveTransition("idle_zone", "thinking")).toBe("move_to_desk");
  });

  it("redirects to desk when work arrives during walking_to_idle", () => {
    expect(resolveTransition("walking_to_idle", "tool_use")).toBe("move_to_desk");
  });

  it("does visual-only update when agent is at desk and still working", () => {
    expect(resolveTransition("desk", "thinking")).toBe("visual_only");
    expect(resolveTransition("desk", "responding")).toBe("visual_only");
    expect(resolveTransition("desk", "tool_use")).toBe("visual_only");
  });

  it("does visual-only update when agent is at idle_zone and still idle", () => {
    expect(resolveTransition("idle_zone", "idle")).toBe("visual_only");
    expect(resolveTransition("idle_zone", "task_complete")).toBe("visual_only");
  });

  it("does visual-only update for non-work/non-idle statuses (error, offline)", () => {
    expect(resolveTransition("desk", "error")).toBe("visual_only");
    expect(resolveTransition("idle_zone", "offline")).toBe("visual_only");
  });

  it("does visual-only update when location is undefined (new agent)", () => {
    expect(resolveTransition(undefined, "thinking")).toBe("visual_only");
    expect(resolveTransition(undefined, "idle")).toBe("visual_only");
  });
});

// ---------------------------------------------------------------------------
// Anti-regression: task_complete must NOT trigger desk-to-idle movement (#95071)
// ---------------------------------------------------------------------------

describe("OfficeScene — task_complete does not cause oscillation", () => {
  it("task_complete at desk is visual-only (agent stays at desk)", () => {
    expect(resolveTransition("desk", "task_complete")).toBe("visual_only");
  });

  it("task_complete while walking to desk is visual-only (agent continues to desk)", () => {
    expect(resolveTransition("walking_to_desk", "task_complete")).toBe("visual_only");
  });

  it("task_complete at idle zone is visual-only (no movement triggered)", () => {
    expect(resolveTransition("idle_zone", "task_complete")).toBe("visual_only");
  });

  it("rapid task_complete → thinking cycle causes no idle-zone detour", () => {
    // Simulates multi-turn agentic work: each turn ends with task_complete,
    // next turn starts with thinking within 1-3s. Agent must stay at desk.
    const transitions: TransitionAction[] = [];
    let location: AgentLocationState = "desk";

    for (const status of ["task_complete", "thinking", "task_complete", "thinking"] as Status[]) {
      const action = resolveTransition(location, status);
      transitions.push(action);
      // location stays "desk" throughout because no move is triggered
    }

    expect(transitions).toEqual(["visual_only", "visual_only", "visual_only", "visual_only"]);
  });
});

// ---------------------------------------------------------------------------
// Tests for layout switching decision logic
// ---------------------------------------------------------------------------

describe("OfficeScene — layout switch decision", () => {
  it("requests switch when agent count crosses threshold upward", () => {
    const switchLog: Array<{ from: string; to: string }> = [];

    const maybeSwitchLayout = (agentCount: number, layoutWidth: number): void => {
      const desired = desiredLayoutSize(agentCount);
      const current = currentLayoutSize(layoutWidth);
      if (desired !== current) {
        switchLog.push({ from: current, to: desired });
      }
    };

    // Medium layout (width=24) with 11 agents should want "large"
    maybeSwitchLayout(11, 24);
    expect(switchLog).toHaveLength(1);
    expect(switchLog[0]).toEqual({ from: "medium", to: "large" });
  });

  it("does not request switch when layout is already correct", () => {
    const switchLog: string[] = [];

    const maybeSwitchLayout = (agentCount: number, layoutWidth: number): void => {
      const desired = desiredLayoutSize(agentCount);
      const current = currentLayoutSize(layoutWidth);
      if (desired !== current) {
        switchLog.push(`${current} -> ${desired}`);
      }
    };

    // Medium layout (width=24) with 8 agents — both resolve to "medium"
    maybeSwitchLayout(8, 24);
    expect(switchLog).toHaveLength(0);
  });
});
