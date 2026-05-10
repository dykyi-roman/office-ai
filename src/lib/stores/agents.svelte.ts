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

const AI_OFFICE_MODEL = "gpt-4o-mini";

const MOCK_AGENTS: AgentState[] = [
  {
    id: "agent-001",
    pid: null,
    name: "PMO",
    model: AI_OFFICE_MODEL,
    tier: "expert",
    role: "Оркестратор задач",
    status: "thinking",
    idleLocation: "desk",
    currentTask: "Принимает задачу, выбирает исполнителя и проверяет качество",
    tokensIn: 12400,
    tokensOut: 3600,
    subAgents: [],
    lastActivity: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
    source: "sdk_hook",
  },
  {
    id: "agent-002",
    pid: null,
    name: "Аналитик",
    model: AI_OFFICE_MODEL,
    tier: "senior",
    role: "Данные и метрики",
    status: "tool_use",
    idleLocation: "standing_desk",
    currentTask: "Собирает показатели, ищет закономерности и готовит выводы",
    tokensIn: 9800,
    tokensOut: 2900,
    subAgents: [],
    lastActivity: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
    source: "sdk_hook",
  },
  {
    id: "agent-003",
    pid: null,
    name: "Разработчик",
    model: AI_OFFICE_MODEL,
    tier: "senior",
    role: "Код и ревью",
    status: "responding",
    idleLocation: "desk",
    currentTask: "Пишет код, объясняет решение и проверяет реализацию",
    tokensIn: 14200,
    tokensOut: 5100,
    subAgents: [],
    lastActivity: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
    source: "sdk_hook",
  },
  {
    id: "agent-004",
    pid: null,
    name: "Копирайтер",
    model: AI_OFFICE_MODEL,
    tier: "middle",
    role: "Контент",
    status: "responding",
    idleLocation: "water_cooler",
    currentTask: "Готовит понятный текст, структуру и финальную редактуру",
    tokensIn: 7600,
    tokensOut: 3400,
    subAgents: [],
    lastActivity: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    source: "sdk_hook",
  },
  {
    id: "agent-005",
    pid: null,
    name: "Поддержка",
    model: AI_OFFICE_MODEL,
    tier: "middle",
    role: "Техподдержка",
    status: "thinking",
    idleLocation: "sofa",
    currentTask: "Разбирает обращение, уточняет проблему и готовит ответ клиенту",
    tokensIn: 6900,
    tokensOut: 2100,
    subAgents: [],
    lastActivity: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    source: "sdk_hook",
  },
  {
    id: "agent-006",
    pid: null,
    name: "Стратег",
    model: AI_OFFICE_MODEL,
    tier: "senior",
    role: "Анализ рынка",
    status: "tool_use",
    idleLocation: "meeting_room",
    currentTask: "Сравнивает конкурентов, оценивает рынок и формирует рекомендации",
    tokensIn: 10800,
    tokensOut: 3900,
    subAgents: [],
    lastActivity: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 39 * 60 * 1000).toISOString(),
    source: "sdk_hook",
  },
  {
    id: "agent-007",
    pid: null,
    name: "Бухгалтер",
    model: AI_OFFICE_MODEL,
    tier: "middle",
    role: "Финансы",
    status: "tool_use",
    idleLocation: "lounge",
    currentTask: "Готовит финансовый отчет, расчеты и пояснения по показателям",
    tokensIn: 9200,
    tokensOut: 2800,
    subAgents: [],
    lastActivity: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    startedAt: new Date(Date.now() - 33 * 60 * 1000).toISOString(),
    source: "sdk_hook",
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
