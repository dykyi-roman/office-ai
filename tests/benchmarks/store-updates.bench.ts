// Performance benchmarks for agent store update operations
// Measures Map mutation throughput at 1, 10, and 20 agent scales
// Run with: npx vitest bench tests/benchmarks/store-updates.bench.ts

import { bench, describe } from "vitest";
import type { AgentState, Status, Tier } from "../../src/lib/types/agent";

// ---------------------------------------------------------------------------
// Pure store logic (mirrors agents.ts without Svelte runtime)
// ---------------------------------------------------------------------------

function makeAgent(id: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    pid: 1000 + parseInt(id.replace(/\D/g, ""), 10) || 0,
    name: `Agent ${id}`,
    model: "claude-sonnet-4-6",
    tier: "senior",
    role: "Developer",
    status: "idle",
    idleLocation: "desk",
    currentTask: null,
    tokensIn: 1000,
    tokensOut: 500,
    lastActivity: "2025-01-01T00:00:00.000Z",
    source: "cli",
    ...overrides,
  };
}

function addAgent(map: Map<string, AgentState>, agent: AgentState): Map<string, AgentState> {
  return new Map(map).set(agent.id, agent);
}

function removeAgent(map: Map<string, AgentState>, id: string): Map<string, AgentState> {
  const next = new Map(map);
  next.delete(id);
  return next;
}

function updateAgent(map: Map<string, AgentState>, agent: AgentState): Map<string, AgentState> {
  return new Map(map).set(agent.id, agent);
}

// Derived values (mirrors store computed properties)
function computeActiveAgents(map: Map<string, AgentState>): AgentState[] {
  return [...map.values()].filter(
    (a) => a.status !== "idle" && a.status !== "offline",
  );
}

function computeTotalTokensIn(map: Map<string, AgentState>): number {
  return [...map.values()].reduce((sum, a) => sum + a.tokensIn, 0);
}

function computeAgentsByTier(map: Map<string, AgentState>): Map<Tier, AgentState[]> {
  return [...map.values()].reduce<Map<Tier, AgentState[]>>((acc, agent) => {
    const list = acc.get(agent.tier) ?? [];
    list.push(agent);
    acc.set(agent.tier, list);
    return acc;
  }, new Map());
}

// ---------------------------------------------------------------------------
// Fixtures: pre-built agent pools
// ---------------------------------------------------------------------------

const agentPool1 = [makeAgent("a1", { status: "thinking", tokensIn: 5000 })];

const agentPool10 = Array.from({ length: 10 }, (_, i) =>
  makeAgent(`a${i}`, {
    status: i % 2 === 0 ? "thinking" : "idle",
    tier: (["flagship", "senior", "middle", "junior"] as Tier[])[i % 4],
    tokensIn: (i + 1) * 1000,
    tokensOut: (i + 1) * 500,
  }),
);

const agentPool20 = Array.from({ length: 20 }, (_, i) =>
  makeAgent(`b${i}`, {
    status: (["idle", "thinking", "responding", "tool_use"] as Status[])[i % 4],
    tier: (["flagship", "senior", "middle", "junior"] as Tier[])[i % 4],
    tokensIn: (i + 1) * 2000,
    tokensOut: (i + 1) * 800,
  }),
);

// ---------------------------------------------------------------------------
// Benchmarks: add agents
// ---------------------------------------------------------------------------

describe("store-updates — addAgent", () => {
  bench("add 1 agent to empty store", () => {
    let map: Map<string, AgentState> = new Map();
    map = addAgent(map, agentPool1[0]);
  });

  bench("add 10 agents sequentially", () => {
    let map: Map<string, AgentState> = new Map();
    for (const agent of agentPool10) {
      map = addAgent(map, agent);
    }
  });

  bench("add 20 agents sequentially", () => {
    let map: Map<string, AgentState> = new Map();
    for (const agent of agentPool20) {
      map = addAgent(map, agent);
    }
  });
});

// ---------------------------------------------------------------------------
// Benchmarks: update agents
// ---------------------------------------------------------------------------

describe("store-updates — updateAgent", () => {
  const baseMap1 = agentPool1.reduce<Map<string, AgentState>>(
    (m, a) => m.set(a.id, a),
    new Map(),
  );

  const baseMap10 = agentPool10.reduce<Map<string, AgentState>>(
    (m, a) => m.set(a.id, a),
    new Map(),
  );

  const baseMap20 = agentPool20.reduce<Map<string, AgentState>>(
    (m, a) => m.set(a.id, a),
    new Map(),
  );

  bench("update 1 agent (single state change)", () => {
    updateAgent(baseMap1, { ...agentPool1[0], status: "thinking" });
  });

  bench("update all 10 agents sequentially", () => {
    let map = baseMap10;
    for (const agent of agentPool10) {
      map = updateAgent(map, { ...agent, status: "responding", tokensIn: agent.tokensIn + 100 });
    }
  });

  bench("update all 20 agents sequentially", () => {
    let map = baseMap20;
    for (const agent of agentPool20) {
      map = updateAgent(map, { ...agent, status: "responding", tokensIn: agent.tokensIn + 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// Benchmarks: remove agents
// ---------------------------------------------------------------------------

describe("store-updates — removeAgent", () => {
  bench("remove 1 agent from 1-agent store", () => {
    let map = agentPool1.reduce<Map<string, AgentState>>(
      (m, a) => m.set(a.id, a),
      new Map(),
    );
    map = removeAgent(map, "a1");
  });

  bench("remove 10 agents from 10-agent store", () => {
    let map = agentPool10.reduce<Map<string, AgentState>>(
      (m, a) => m.set(a.id, a),
      new Map(),
    );
    for (let i = 0; i < 10; i++) {
      map = removeAgent(map, `a${i}`);
    }
  });

  bench("remove 20 agents from 20-agent store", () => {
    let map = agentPool20.reduce<Map<string, AgentState>>(
      (m, a) => m.set(a.id, a),
      new Map(),
    );
    for (let i = 0; i < 20; i++) {
      map = removeAgent(map, `b${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Benchmarks: derived value recomputation
// ---------------------------------------------------------------------------

describe("store-updates — derived value recomputation", () => {
  const map1 = agentPool1.reduce<Map<string, AgentState>>(
    (m, a) => m.set(a.id, a),
    new Map(),
  );

  const map10 = agentPool10.reduce<Map<string, AgentState>>(
    (m, a) => m.set(a.id, a),
    new Map(),
  );

  const map20 = agentPool20.reduce<Map<string, AgentState>>(
    (m, a) => m.set(a.id, a),
    new Map(),
  );

  bench("computeActiveAgents with 1 agent", () => {
    computeActiveAgents(map1);
  });

  bench("computeActiveAgents with 10 agents", () => {
    computeActiveAgents(map10);
  });

  bench("computeActiveAgents with 20 agents", () => {
    computeActiveAgents(map20);
  });

  bench("computeTotalTokensIn with 20 agents", () => {
    computeTotalTokensIn(map20);
  });

  bench("computeAgentsByTier with 20 agents", () => {
    computeAgentsByTier(map20);
  });

  bench("all three derived values with 20 agents", () => {
    computeActiveAgents(map20);
    computeTotalTokensIn(map20);
    computeAgentsByTier(map20);
  });
});

// ---------------------------------------------------------------------------
// Benchmarks: full state cycle (add → update → remove)
// ---------------------------------------------------------------------------

describe("store-updates — full lifecycle cycle", () => {
  bench("lifecycle for 1 agent (add → update → remove)", () => {
    let map: Map<string, AgentState> = new Map();
    const agent = makeAgent("lifecycle-1");

    map = addAgent(map, agent);
    map = updateAgent(map, { ...agent, status: "thinking" });
    map = updateAgent(map, { ...agent, status: "task_complete" });
    map = removeAgent(map, agent.id);
  });

  bench("lifecycle for 10 agents (add all → update all → remove all)", () => {
    let map: Map<string, AgentState> = new Map();
    const agents = Array.from({ length: 10 }, (_, i) => makeAgent(`lc${i}`));

    for (const a of agents) map = addAgent(map, a);
    for (const a of agents) map = updateAgent(map, { ...a, status: "thinking" });
    for (const a of agents) map = removeAgent(map, a.id);
  });

  bench("lifecycle for 20 agents (add all → update all → remove all)", () => {
    let map: Map<string, AgentState> = new Map();
    const agents = Array.from({ length: 20 }, (_, i) => makeAgent(`lc${i}`));

    for (const a of agents) map = addAgent(map, a);
    for (const a of agents) map = updateAgent(map, { ...a, status: "responding" });
    for (const a of agents) map = removeAgent(map, a.id);
  });
});
