// Office state store — manages selected agent, layout size, camera position

import type { LayoutSize } from "$lib/types/index";
import type { AgentState } from "$lib/types/index";
import { getAgent, getAgentCount } from "./agents.svelte";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

let selectedAgentId = $state<string | null>(null);

let cameraPosition = $state<{ x: number; y: number }>({ x: 0, y: 0 });

// Derived: sidebar is open when an agent is selected
const sidebarOpen = $derived(selectedAgentId !== null);

// Derived: layout size based on agent count
const currentLayoutSize = $derived<LayoutSize>((() => {
  const count = getAgentCount();
  if (count <= 4) return "small";
  if (count <= 10) return "medium";
  if (count <= 20) return "large";
  return "campus";
})());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function selectAgent(id: string): void {
  selectedAgentId = id;
}

export function deselectAgent(): void {
  selectedAgentId = null;
}

export function getSelectedAgent(): AgentState | undefined {
  if (selectedAgentId === null) return undefined;
  return getAgent(selectedAgentId);
}

export function getSelectedAgentId(): string | null {
  return selectedAgentId;
}

export function isSidebarOpen(): boolean {
  return sidebarOpen;
}

export function getCurrentLayoutSize(): LayoutSize {
  return currentLayoutSize;
}

export function getCameraPosition(): { x: number; y: number } {
  return cameraPosition;
}

export function setCameraPosition(x: number, y: number): void {
  cameraPosition = { x, y };
}
