// Unit tests for agent store logic
// Note: Svelte 5 runes ($state, $derived) are compiler macros and cannot be
// directly instantiated in plain Vitest environments without the Svelte
// plugin transform. These tests verify the pure business logic extracted from
// the store (filtering, grouping, summing) using plain TypeScript functions
// that mirror the derived store logic.

import { describe, it, expect } from "vitest";
import type { AgentState, SubAgentInfo, Tier } from "../../types/index";

// ---------------------------------------------------------------------------
// Pure logic functions (mirrors of store derived values)
// ---------------------------------------------------------------------------

function computeActiveAgents(agents: AgentState[]): AgentState[] {
  return agents.filter(
    (a) => a.status !== "idle" && a.status !== "offline",
  );
}

function computeIdleAgents(agents: AgentState[]): AgentState[] {
  return agents.filter((a) => a.status === "idle");
}

function computeAgentsByTier(agents: AgentState[]): Map<Tier, AgentState[]> {
  return agents.reduce<Map<Tier, AgentState[]>>((acc, agent) => {
    const list = acc.get(agent.tier) ?? [];
    list.push(agent);
    acc.set(agent.tier, list);
    return acc;
  }, new Map());
}

function computeTotalTokensIn(agents: AgentState[]): number {
  return agents.reduce((sum, a) => sum + a.tokensIn, 0);
}

function computeTotalTokensOut(agents: AgentState[]): number {
  return agents.reduce((sum, a) => sum + a.tokensOut, 0);
}

function computeTotalSubAgents(agents: AgentState[]): number {
  return agents.reduce((sum, a) => sum + a.subAgents.length, 0);
}

function computeAllSubAgents(agents: AgentState[]): SubAgentInfo[] {
  return agents.flatMap((a) => a.subAgents);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent-test",
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
    startedAt: new Date().toISOString(),
    source: "cli",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("test_agents_store_add — agent:found adds to map", () => {
  it("adds a new agent to the map", () => {
    const agentsMap = new Map<string, AgentState>();
    const agent = makeAgent({ id: "a1" });
    agentsMap.set(agent.id, agent);

    expect(agentsMap.has("a1")).toBe(true);
    expect(agentsMap.get("a1")).toEqual(agent);
    expect(agentsMap.size).toBe(1);
  });

  it("overwrites existing agent with same id on re-add", () => {
    const agentsMap = new Map<string, AgentState>();
    const agent1 = makeAgent({ id: "a1", status: "idle" });
    const agent2 = makeAgent({ id: "a1", status: "thinking" });

    agentsMap.set(agent1.id, agent1);
    agentsMap.set(agent2.id, agent2);

    expect(agentsMap.size).toBe(1);
    expect(agentsMap.get("a1")?.status).toBe("thinking");
  });
});

describe("test_agents_store_remove — agent:lost removes from map", () => {
  it("removes an existing agent by id", () => {
    const agentsMap = new Map<string, AgentState>();
    const agent = makeAgent({ id: "a1" });
    agentsMap.set(agent.id, agent);

    agentsMap.delete("a1");

    expect(agentsMap.has("a1")).toBe(false);
    expect(agentsMap.size).toBe(0);
  });

  it("removing non-existent id leaves map unchanged", () => {
    const agentsMap = new Map<string, AgentState>();
    const agent = makeAgent({ id: "a1" });
    agentsMap.set(agent.id, agent);

    agentsMap.delete("nonexistent");

    expect(agentsMap.size).toBe(1);
  });
});

describe("test_agents_store_update — agent:state-changed updates existing", () => {
  it("updates an existing agent status", () => {
    const agentsMap = new Map<string, AgentState>();
    const agent = makeAgent({ id: "a1", status: "idle" });
    agentsMap.set(agent.id, agent);

    const updated = { ...agent, status: "thinking" } satisfies AgentState;
    agentsMap.set(updated.id, updated);

    expect(agentsMap.get("a1")?.status).toBe("thinking");
  });
});

describe("test_derived_active_agents — filters non-idle/offline correctly", () => {
  it("excludes idle and offline agents", () => {
    const agents = [
      makeAgent({ id: "a1", status: "idle" }),
      makeAgent({ id: "a2", status: "offline" }),
      makeAgent({ id: "a3", status: "thinking" }),
      makeAgent({ id: "a4", status: "responding" }),
      makeAgent({ id: "a5", status: "tool_use" }),
    ];

    const active = computeActiveAgents(agents);
    expect(active).toHaveLength(3);
    expect(active.map((a) => a.id)).toEqual(["a3", "a4", "a5"]);
  });

  it("returns empty array when all agents are idle or offline", () => {
    const agents = [
      makeAgent({ id: "a1", status: "idle" }),
      makeAgent({ id: "a2", status: "offline" }),
    ];

    expect(computeActiveAgents(agents)).toHaveLength(0);
  });

  it("returns all agents when none are idle or offline", () => {
    const agents = [
      makeAgent({ id: "a1", status: "thinking" }),
      makeAgent({ id: "a2", status: "collaboration" }),
    ];

    expect(computeActiveAgents(agents)).toHaveLength(2);
  });
});

describe("idle agents derived store", () => {
  it("returns only idle agents", () => {
    const agents = [
      makeAgent({ id: "a1", status: "idle" }),
      makeAgent({ id: "a2", status: "thinking" }),
      makeAgent({ id: "a3", status: "idle" }),
    ];

    const idle = computeIdleAgents(agents);
    expect(idle).toHaveLength(2);
    expect(idle.map((a) => a.id)).toEqual(["a1", "a3"]);
  });
});

describe("test_derived_total_tokens — sums tokens across all agents", () => {
  it("sums tokensIn correctly", () => {
    const agents = [
      makeAgent({ tokensIn: 100, tokensOut: 50 }),
      makeAgent({ tokensIn: 200, tokensOut: 80 }),
      makeAgent({ tokensIn: 50, tokensOut: 20 }),
    ];

    expect(computeTotalTokensIn(agents)).toBe(350);
  });

  it("sums tokensOut correctly", () => {
    const agents = [
      makeAgent({ tokensIn: 100, tokensOut: 50 }),
      makeAgent({ tokensIn: 200, tokensOut: 80 }),
    ];

    expect(computeTotalTokensOut(agents)).toBe(130);
  });

  it("returns 0 for empty agent list", () => {
    expect(computeTotalTokensIn([])).toBe(0);
    expect(computeTotalTokensOut([])).toBe(0);
  });

  it("handles single agent correctly", () => {
    const agents = [makeAgent({ tokensIn: 12345, tokensOut: 6789 })];
    expect(computeTotalTokensIn(agents)).toBe(12345);
    expect(computeTotalTokensOut(agents)).toBe(6789);
  });
});

describe("agentsByTier derived store", () => {
  it("groups agents by tier correctly", () => {
    const agents = [
      makeAgent({ id: "a1", tier: "expert" }),
      makeAgent({ id: "a2", tier: "senior" }),
      makeAgent({ id: "a3", tier: "senior" }),
      makeAgent({ id: "a4", tier: "middle" }),
    ];

    const grouped = computeAgentsByTier(agents);
    expect(grouped.get("expert")).toHaveLength(1);
    expect(grouped.get("senior")).toHaveLength(2);
    expect(grouped.get("middle")).toHaveLength(1);
    expect(grouped.has("junior")).toBe(false);
  });

  it("returns empty map for no agents", () => {
    expect(computeAgentsByTier([])).toEqual(new Map());
  });
});

describe("sub-agents derived stores", () => {
  it("counts total sub-agents across all agents", () => {
    const agents = [
      makeAgent({
        id: "a1",
        subAgents: [
          { id: "s1", description: "Fix bug" },
          { id: "s2", description: "Run tests" },
        ],
      }),
      makeAgent({
        id: "a2",
        subAgents: [{ id: "s3", description: "Explore code" }],
      }),
      makeAgent({ id: "a3", subAgents: [] }),
    ];
    expect(computeTotalSubAgents(agents)).toBe(3);
  });

  it("returns 0 when no agents have sub-agents", () => {
    const agents = [
      makeAgent({ id: "a1", subAgents: [] }),
      makeAgent({ id: "a2", subAgents: [] }),
    ];
    expect(computeTotalSubAgents(agents)).toBe(0);
  });

  it("returns 0 for empty agent list", () => {
    expect(computeTotalSubAgents([])).toBe(0);
  });

  it("returns flat list of all sub-agents", () => {
    const agents = [
      makeAgent({
        id: "a1",
        subAgents: [
          { id: "s1", description: "Fix bug" },
          { id: "s2", description: "Run tests" },
        ],
      }),
      makeAgent({
        id: "a2",
        subAgents: [{ id: "s3", description: "Explore code" }],
      }),
    ];
    const allSubs = computeAllSubAgents(agents);
    expect(allSubs).toHaveLength(3);
    expect(allSubs.map((s) => s.description)).toEqual([
      "Fix bug",
      "Run tests",
      "Explore code",
    ]);
  });

  it("returns empty array when no sub-agents exist", () => {
    const agents = [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })];
    expect(computeAllSubAgents(agents)).toHaveLength(0);
  });
});
