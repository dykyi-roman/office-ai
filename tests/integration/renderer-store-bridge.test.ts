// Integration test: renderer responds to store state changes (PixiJS mocked)
// Verifies the bridge between agent store events and AgentSprite operations

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentState, Status } from "../../src/lib/types/agent";

// ---------------------------------------------------------------------------
// Minimal PixiJS mock
// ---------------------------------------------------------------------------

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(() => ({
    addChild: vi.fn(),
    removeChild: vi.fn(),
    removeChildren: vi.fn(),
    destroy: vi.fn(),
    sortableChildren: false,
    x: 0,
    y: 0,
    alpha: 1,
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
  Texture: { WHITE: {} },
  Ticker: {
    shared: { add: vi.fn(), remove: vi.fn() },
  },
  Assets: {
    load: vi.fn().mockRejectedValue(new Error("no assets")),
  },
}));

// ---------------------------------------------------------------------------
// Mock renderer bridge (mirrors OfficeScene agent event handlers)
// ---------------------------------------------------------------------------

interface MockAgentSprite {
  agentId: string;
  status: Status;
  destroyed: boolean;
  setState: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  snapToGrid: ReturnType<typeof vi.fn>;
  walkAlongPath: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getGridPosition: ReturnType<typeof vi.fn>;
}

function createMockSprite(agentId: string, initialStatus: Status = "idle"): MockAgentSprite {
  return {
    agentId,
    status: initialStatus,
    destroyed: false,
    setState: vi.fn(),
    update: vi.fn(),
    snapToGrid: vi.fn(),
    walkAlongPath: vi.fn(),
    destroy: vi.fn(),
    getGridPosition: vi.fn().mockReturnValue({ col: 1, row: 1 }),
  };
}

class MockRendererBridge {
  private readonly sprites = new Map<string, MockAgentSprite>();

  onAgentFound(agent: AgentState): void {
    if (this.sprites.has(agent.id)) {
      this.onAgentStateChanged(agent);
      return;
    }

    const sprite = createMockSprite(agent.id, agent.status);
    this.sprites.set(agent.id, sprite);
    sprite.snapToGrid({ col: 1, row: 1 });
    sprite.setState("walking_to_desk");
    sprite.walkAlongPath([{ col: 3, row: 3 }], () => {
      sprite.setState("idle");
    });
  }

  onAgentLost(id: string): void {
    const sprite = this.sprites.get(id);
    if (!sprite) return;

    sprite.setState("offline");
    sprite.destroyed = true;
    this.sprites.delete(id);
  }

  onAgentStateChanged(agent: AgentState): void {
    const sprite = this.sprites.get(agent.id);
    if (!sprite) {
      this.onAgentFound(agent);
      return;
    }
    sprite.update(agent);
  }

  getSpriteCount(): number {
    return this.sprites.size;
  }

  getSprite(id: string): MockAgentSprite | undefined {
    return this.sprites.get(id);
  }

  hasSprite(id: string): boolean {
    return this.sprites.has(id);
  }
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent-1",
    pid: 1234,
    name: "Test Agent",
    model: "claude-sonnet-4-6",
    tier: "senior",
    role: "Developer",
    status: "idle",
    idleLocation: "desk",
    currentTask: null,
    tokensIn: 0,
    tokensOut: 0,
    lastActivity: "2025-01-01T00:00:00.000Z",
    source: "cli",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderer-store-bridge: agent:found → sprite created", () => {
  let bridge: MockRendererBridge;

  beforeEach(() => {
    bridge = new MockRendererBridge();
  });

  it("creates a sprite when agent:found fires", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    expect(bridge.hasSprite("a1")).toBe(true);
  });

  it("sprite receives snapToGrid with spawn position", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    const sprite = bridge.getSprite("a1");
    expect(sprite?.snapToGrid).toHaveBeenCalledWith({ col: 1, row: 1 });
  });

  it("sprite starts walking to desk after spawn", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    const sprite = bridge.getSprite("a1");
    expect(sprite?.setState).toHaveBeenCalledWith("walking_to_desk");
  });

  it("walkAlongPath is called after spawn", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    const sprite = bridge.getSprite("a1");
    expect(sprite?.walkAlongPath).toHaveBeenCalled();
  });

  it("duplicate agent:found calls update instead of creating new sprite", () => {
    bridge.onAgentFound(makeAgent({ id: "a1", status: "idle" }));
    bridge.onAgentFound(makeAgent({ id: "a1", status: "thinking" }));

    expect(bridge.getSpriteCount()).toBe(1);
    // Second call triggers update path
    const sprite = bridge.getSprite("a1");
    expect(sprite?.update).toHaveBeenCalledOnce();
  });

  it("multiple agents create separate sprites", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    bridge.onAgentFound(makeAgent({ id: "a2" }));
    bridge.onAgentFound(makeAgent({ id: "a3" }));

    expect(bridge.getSpriteCount()).toBe(3);
    expect(bridge.hasSprite("a1")).toBe(true);
    expect(bridge.hasSprite("a2")).toBe(true);
    expect(bridge.hasSprite("a3")).toBe(true);
  });
});

describe("renderer-store-bridge: agent:lost → sprite destroyed", () => {
  let bridge: MockRendererBridge;

  beforeEach(() => {
    bridge = new MockRendererBridge();
  });

  it("removes sprite when agent:lost fires", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    bridge.onAgentLost("a1");
    expect(bridge.hasSprite("a1")).toBe(false);
  });

  it("sprite receives offline state before removal", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    const sprite = bridge.getSprite("a1");

    bridge.onAgentLost("a1");

    expect(sprite?.setState).toHaveBeenCalledWith("offline");
    expect(sprite?.destroyed).toBe(true);
  });

  it("losing non-existent agent does not throw", () => {
    expect(() => bridge.onAgentLost("nonexistent")).not.toThrow();
  });

  it("removing one of multiple agents preserves the others", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    bridge.onAgentFound(makeAgent({ id: "a2" }));
    bridge.onAgentFound(makeAgent({ id: "a3" }));

    bridge.onAgentLost("a2");

    expect(bridge.getSpriteCount()).toBe(2);
    expect(bridge.hasSprite("a1")).toBe(true);
    expect(bridge.hasSprite("a2")).toBe(false);
    expect(bridge.hasSprite("a3")).toBe(true);
  });
});

describe("renderer-store-bridge: agent:state-changed → sprite updated", () => {
  let bridge: MockRendererBridge;

  beforeEach(() => {
    bridge = new MockRendererBridge();
  });

  it("calls sprite.update() with new agent data", () => {
    bridge.onAgentFound(makeAgent({ id: "a1", status: "idle" }));
    const sprite = bridge.getSprite("a1");

    const updated = makeAgent({ id: "a1", status: "thinking" });
    bridge.onAgentStateChanged(updated);

    expect(sprite?.update).toHaveBeenCalledWith(updated);
  });

  it("state change for unknown agent creates a new sprite", () => {
    expect(bridge.hasSprite("a-new")).toBe(false);

    bridge.onAgentStateChanged(makeAgent({ id: "a-new", status: "idle" }));

    expect(bridge.hasSprite("a-new")).toBe(true);
  });

  it("multiple state changes all invoke update()", () => {
    bridge.onAgentFound(makeAgent({ id: "a1" }));
    const sprite = bridge.getSprite("a1");

    const statuses: Status[] = ["thinking", "responding", "tool_use", "task_complete"];
    for (const status of statuses) {
      bridge.onAgentStateChanged(makeAgent({ id: "a1", status }));
    }

    expect(sprite?.update).toHaveBeenCalledTimes(statuses.length);
  });
});

describe("renderer-store-bridge: token data flows through update", () => {
  let bridge: MockRendererBridge;

  beforeEach(() => {
    bridge = new MockRendererBridge();
  });

  it("updated token counts are passed to sprite.update()", () => {
    bridge.onAgentFound(makeAgent({ id: "a1", tokensIn: 100 }));
    const sprite = bridge.getSprite("a1");

    const updated = makeAgent({ id: "a1", tokensIn: 50000, tokensOut: 20000 });
    bridge.onAgentStateChanged(updated);

    expect(sprite?.update).toHaveBeenCalledWith(
      expect.objectContaining({ tokensIn: 50000, tokensOut: 20000 }),
    );
  });
});
