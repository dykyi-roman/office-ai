// Reactive agent state store — subscribes to Tauri IPC events

import type { AgentState, SubAgentInfo, Tier } from "$lib/types/index";
import {
  TAURI_EVENTS,
  type AgentFoundPayload,
  type AgentLostPayload,
  type AgentStateChangedPayload,
} from "$lib/types/index";
import { getSetting } from "$lib/stores/settings.svelte";

// ---------------------------------------------------------------------------
// Mock data for development when Tauri is not available
// ---------------------------------------------------------------------------

const MOCK_AGENTS: AgentState[] = [
  {
    id: "agent-001",
    pid: 12345,
    name: "Claude Opus",
    model: "claude-opus-4-6",
    tier: "flagship",
    role: "Architect",
    status: "thinking",
    idleLocation: "desk",
    currentTask: "Designing the isometric tile system for the office renderer",
    tokensIn: 45200,
    tokensOut: 12800,
    subAgents: [
      { id: "sa-1", description: "Explore codebase structure" },
      { id: "sa-2", description: "Run integration tests" },
      { id: "sa-3", description: "Generate sprite assets" },
    ],
    lastActivity: new Date(Date.now() - 3600 * 1000).toISOString(),
    source: "cli",
  },
  {
    id: "agent-002",
    pid: 12346,
    name: "Claude Sonnet",
    model: "claude-sonnet-4-6",
    tier: "senior",
    role: "Backend",
    status: "tool_use",
    idleLocation: "standing_desk",
    currentTask: "Parsing sysinfo process list for agent discovery",
    tokensIn: 22100,
    tokensOut: 8900,
    subAgents: [
      { id: "sa-4", description: "Scan process list" },
      { id: "sa-5", description: "Parse JSONL logs" },
    ],
    lastActivity: new Date(Date.now() - 1800 * 1000).toISOString(),
    source: "cli",
  },
  {
    id: "agent-003",
    pid: 12347,
    name: "Claude Haiku",
    model: "claude-haiku-3-5",
    tier: "middle",
    role: "UI/UX",
    status: "responding",
    idleLocation: "desk",
    currentTask: null,
    tokensIn: 8400,
    tokensOut: 3200,
    subAgents: [],
    lastActivity: new Date(Date.now() - 900 * 1000).toISOString(),
    source: "browser_extension",
  },
  {
    id: "agent-004",
    pid: null,
    name: "GPT-4o",
    model: "gpt-4o",
    tier: "senior",
    role: "QA",
    status: "idle",
    idleLocation: "water_cooler",
    currentTask: null,
    tokensIn: 5100,
    tokensOut: 1900,
    subAgents: [],
    lastActivity: new Date(Date.now() - 7200 * 1000).toISOString(),
    source: "browser_extension",
  },
];

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

let agents = $state<Map<string, AgentState>>(new Map());

// Derived: agents that are actively working (not idle or offline)
const activeAgents = $derived(
  [...agents.values()].filter(
    (a) => a.status !== "idle" && a.status !== "offline",
  ),
);

// Derived: agents that are idle
const idleAgents = $derived(
  [...agents.values()].filter((a) => a.status === "idle"),
);

// Derived: agents grouped by tier
const agentsByTier = $derived(
  [...agents.values()].reduce<Map<Tier, AgentState[]>>((acc, agent) => {
    const list = acc.get(agent.tier) ?? [];
    list.push(agent);
    acc.set(agent.tier, list);
    return acc;
  }, new Map()),
);

// Derived: sum of all tokensIn across agents
const totalTokensIn = $derived(
  [...agents.values()].reduce((sum, a) => sum + a.tokensIn, 0),
);

// Derived: sum of all tokensOut across agents
const totalTokensOut = $derived(
  [...agents.values()].reduce((sum, a) => sum + a.tokensOut, 0),
);

// Derived: total number of sub-agents across all agents
const totalSubAgents = $derived(
  [...agents.values()].reduce((sum, a) => sum + a.subAgents.length, 0),
);

// Derived: flat list of all sub-agents across all agents
const allSubAgents = $derived(
  [...agents.values()].flatMap((a) => a.subAgents),
);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function applyMockData(): void {
  for (const agent of MOCK_AGENTS) {
    agents.set(agent.id, agent);
  }
  // Trigger reactivity by reassigning the map reference
  agents = new Map(agents);
}

function addAgent(agent: AgentState): void {
  // Enforce maxAgents limit — skip if already at capacity (unless updating existing)
  if (!agents.has(agent.id) && agents.size >= getSetting("maxAgents")) {
    return;
  }
  agents = new Map(agents).set(agent.id, agent);
}

function removeAgent(id: string): void {
  const next = new Map(agents);
  next.delete(id);
  agents = next;
}

function updateAgent(agent: AgentState): void {
  // Only update agents already tracked — never add new ones via state-changed
  if (!agents.has(agent.id)) return;
  agents = new Map(agents).set(agent.id, agent);
}

// ---------------------------------------------------------------------------
// Tauri event subscription (initialised once)
// ---------------------------------------------------------------------------

let initialized = false;

export async function initAgentsStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    // Attempt to import Tauri listen — fails gracefully in browser dev mode
    const { listen } = await import("@tauri-apps/api/event");

    await listen<AgentFoundPayload>(TAURI_EVENTS.AGENT_FOUND, (event) => {
      addAgent(event.payload.agent);
    });

    await listen<AgentLostPayload>(TAURI_EVENTS.AGENT_LOST, (event) => {
      removeAgent(event.payload.id);
    });

    await listen<AgentStateChangedPayload>(
      TAURI_EVENTS.AGENT_STATE_CHANGED,
      (event) => {
        updateAgent(event.payload.agent);
      },
    );

    // Try to load existing agents from the backend
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const existingAgents = await invoke<AgentState[]>("get_all_agents");
      for (const agent of existingAgents) {
        addAgent(agent);
      }
    } catch {
      // Backend not ready yet — use mock data in dev
      applyMockData();
    }
  } catch {
    // Tauri not available (browser dev mode) — use mock data
    applyMockData();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAgent(id: string): AgentState | undefined {
  return agents.get(id);
}

export function getAllAgents(): AgentState[] {
  return [...agents.values()];
}

export function getAgentCount(): number {
  return agents.size;
}

// Export reactive getters as functions for use in Svelte templates
export function getAgents(): Map<string, AgentState> {
  return agents;
}

export function getActiveAgents(): AgentState[] {
  return activeAgents;
}

export function getIdleAgents(): AgentState[] {
  return idleAgents;
}

export function getAgentsByTier(): Map<Tier, AgentState[]> {
  return agentsByTier;
}

export function getTotalTokensIn(): number {
  return totalTokensIn;
}

export function getTotalTokensOut(): number {
  return totalTokensOut;
}

export function getTotalSubAgents(): number {
  return totalSubAgents;
}

export function getAllSubAgents(): SubAgentInfo[] {
  return allSubAgents;
}
