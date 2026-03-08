// Integration test: agent store changes propagate to derived values correctly
// Tests pure derived-value logic that mirrors the Svelte 5 runes store

import { describe, it, expect } from "vitest";
import type { AgentState, Tier, Status } from "../../src/lib/types/agent";

// ---------------------------------------------------------------------------
// Mirror of store derived logic (tested without Svelte runtime)
// ---------------------------------------------------------------------------

interface StoreState {
  agents: Map<string, AgentState>;
}

function computeActiveAgents(state: StoreState): AgentState[] {
  return [...state.agents.values()].filter(
    (a) => a.status !== "idle" && a.status !== "offline",
  );
}

function computeIdleAgents(state: StoreState): AgentState[] {
  return [...state.agents.values()].filter((a) => a.status === "idle");
}

function computeAgentsByTier(state: StoreState): Map<Tier, AgentState[]> {
  return [...state.agents.values()].reduce<Map<Tier, AgentState[]>>(
    (acc, agent) => {
      const list = acc.get(agent.tier) ?? [];
      list.push(agent);
      acc.set(agent.tier, list);
      return acc;
    },
    new Map(),
  );
}

function computeTotalTokensIn(state: StoreState): number {
  return [...state.agents.values()].reduce((sum, a) => sum + a.tokensIn, 0);
}

function computeTotalTokensOut(state: StoreState): number {
  return [...state.agents.values()].reduce((sum, a) => sum + a.tokensOut, 0);
}

// Store mutation helpers (mirror addAgent / removeAgent / updateAgent)
function addAgent(state: StoreState, agent: AgentState): StoreState {
  return { agents: new Map(state.agents).set(agent.id, agent) };
}

function removeAgent(state: StoreState, id: string): StoreState {
  const next = new Map(state.agents);
  next.delete(id);
  return { agents: next };
}

function updateAgent(state: StoreState, agent: AgentState): StoreState {
  return { agents: new Map(state.agents).set(agent.id, agent) };
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent-1",
    pid: 1000,
    name: "Test Agent",
    model: "claude-sonnet-4-6",
    tier: "senior",
    role: "Developer",
    status: "idle",
    idleLocation: "desk",
    currentTask: null,
    tokensIn: 100,
    tokensOut: 50,
    lastActivity: "2025-01-01T00:00:00.000Z",
    source: "cli",
    ...overrides,
  };
}

function emptyStore(): StoreState {
  return { agents: new Map() };
}

// ---------------------------------------------------------------------------
// Tests: agent:found propagation
// ---------------------------------------------------------------------------

describe("store-sync: agent:found → derived values update", () => {
  it("adding an idle agent increases total count", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", status: "idle" }));

    expect(state.agents.size).toBe(1);
    expect(computeIdleAgents(state)).toHaveLength(1);
    expect(computeActiveAgents(state)).toHaveLength(0);
  });

  it("adding a thinking agent updates activeAgents derived value", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", status: "thinking" }));

    expect(computeActiveAgents(state)).toHaveLength(1);
    expect(computeIdleAgents(state)).toHaveLength(0);
  });

  it("adding multiple agents propagates to grouped-by-tier", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", tier: "expert" }));
    state = addAgent(state, makeAgent({ id: "a2", tier: "expert" }));
    state = addAgent(state, makeAgent({ id: "a3", tier: "junior" }));

    const grouped = computeAgentsByTier(state);
    expect(grouped.get("expert")).toHaveLength(2);
    expect(grouped.get("junior")).toHaveLength(1);
  });

  it("token totals update after adding agents", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", tokensIn: 500, tokensOut: 200 }));
    state = addAgent(state, makeAgent({ id: "a2", tokensIn: 300, tokensOut: 100 }));

    expect(computeTotalTokensIn(state)).toBe(800);
    expect(computeTotalTokensOut(state)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent:lost propagation
// ---------------------------------------------------------------------------

describe("store-sync: agent:lost → derived values update", () => {
  it("removing an agent reduces total count", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1" }));
    state = addAgent(state, makeAgent({ id: "a2" }));

    state = removeAgent(state, "a1");

    expect(state.agents.size).toBe(1);
    expect(state.agents.has("a1")).toBe(false);
    expect(state.agents.has("a2")).toBe(true);
  });

  it("removing an active agent updates activeAgents", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", status: "thinking" }));
    state = addAgent(state, makeAgent({ id: "a2", status: "idle" }));

    state = removeAgent(state, "a1");

    expect(computeActiveAgents(state)).toHaveLength(0);
  });

  it("token totals decrease after agent is removed", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", tokensIn: 400 }));
    state = addAgent(state, makeAgent({ id: "a2", tokensIn: 200 }));

    state = removeAgent(state, "a1");

    expect(computeTotalTokensIn(state)).toBe(200);
  });

  it("removing non-existent agent leaves state unchanged", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1" }));
    const before = state.agents.size;

    state = removeAgent(state, "nonexistent");

    expect(state.agents.size).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent:state-changed propagation
// ---------------------------------------------------------------------------

describe("store-sync: agent:state-changed → derived values update", () => {
  it("idle→thinking moves agent from idle to active derived", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", status: "idle" }));

    expect(computeIdleAgents(state)).toHaveLength(1);
    expect(computeActiveAgents(state)).toHaveLength(0);

    state = updateAgent(state, makeAgent({ id: "a1", status: "thinking" }));

    expect(computeIdleAgents(state)).toHaveLength(0);
    expect(computeActiveAgents(state)).toHaveLength(1);
  });

  it("thinking→task_complete keeps agent in active derived", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", status: "thinking" }));
    state = updateAgent(state, makeAgent({ id: "a1", status: "task_complete" }));

    expect(computeActiveAgents(state)).toHaveLength(1);
    expect(computeIdleAgents(state)).toHaveLength(0);
  });

  it("task_complete→idle moves agent back to idle derived", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", status: "task_complete" }));
    state = updateAgent(state, makeAgent({ id: "a1", status: "idle" }));

    expect(computeIdleAgents(state)).toHaveLength(1);
    expect(computeActiveAgents(state)).toHaveLength(0);
  });

  it("token update propagates to total token derived values", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", tokensIn: 100, tokensOut: 50 }));

    state = updateAgent(
      state,
      makeAgent({ id: "a1", tokensIn: 5000, tokensOut: 2000 }),
    );

    expect(computeTotalTokensIn(state)).toBe(5000);
    expect(computeTotalTokensOut(state)).toBe(2000);
  });

  it("tier change updates agentsByTier grouping", () => {
    let state = emptyStore();
    state = addAgent(state, makeAgent({ id: "a1", tier: "junior" }));

    state = updateAgent(state, makeAgent({ id: "a1", tier: "senior" }));

    const grouped = computeAgentsByTier(state);
    expect(grouped.has("junior")).toBe(false);
    expect(grouped.get("senior")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: full lifecycle cycle
// ---------------------------------------------------------------------------

describe("store-sync: full agent lifecycle", () => {
  it("add → update status → remove cycle leaves store empty", () => {
    let state = emptyStore();

    state = addAgent(state, makeAgent({ id: "lifecycle-agent", status: "idle" }));
    expect(state.agents.size).toBe(1);

    state = updateAgent(
      state,
      makeAgent({ id: "lifecycle-agent", status: "thinking" }),
    );
    expect(computeActiveAgents(state)).toHaveLength(1);

    state = updateAgent(
      state,
      makeAgent({ id: "lifecycle-agent", status: "task_complete" }),
    );
    expect(computeActiveAgents(state)).toHaveLength(1);

    state = updateAgent(
      state,
      makeAgent({ id: "lifecycle-agent", status: "idle" }),
    );
    expect(computeIdleAgents(state)).toHaveLength(1);

    state = removeAgent(state, "lifecycle-agent");
    expect(state.agents.size).toBe(0);
    expect(computeTotalTokensIn(state)).toBe(0);
    expect(computeTotalTokensOut(state)).toBe(0);
  });

  it("5 agents: layout size reflects count correctly", () => {
    let state = emptyStore();
    const agents = Array.from({ length: 5 }, (_, i) =>
      makeAgent({ id: `agent-${i}`, status: i % 2 === 0 ? "thinking" : "idle" }),
    );

    for (const agent of agents) {
      state = addAgent(state, agent);
    }

    expect(state.agents.size).toBe(5);

    const count = state.agents.size;
    // Layout threshold logic: 5 agents → "medium"
    const layoutSize =
      count <= 4 ? "small" : count <= 10 ? "medium" : count <= 20 ? "large" : "campus";
    expect(layoutSize).toBe("medium");
  });
});
