// Tauri event → sound trigger bridge — subscribes independently to IPC events

import type { Status } from "$lib/types/index";
import {
  TAURI_EVENTS,
  type AgentFoundPayload,
  type AgentLostPayload,
  type AgentStateChangedPayload,
} from "$lib/types/index";
import { getSetting } from "$lib/stores/settings.svelte";
import { SoundEngine } from "./SoundEngine";
import { STATUS_SOUND_MAP, type SoundEvent } from "./SoundDefinitions";

type UnlistenFn = () => void;

let engine: SoundEngine | null = null;
let unlisteners: UnlistenFn[] = [];
let agentPreviousStatus = new Map<string, Status>();
let contextActivated = false;

function activateContext(): void {
  if (contextActivated) return;
  contextActivated = true;
  engine?.ensureContext();
}

function handleUserGesture(): void {
  activateContext();
  document.removeEventListener("click", handleUserGesture);
  document.removeEventListener("keydown", handleUserGesture);
}

function playIfEnabled(event: SoundEvent): void {
  if (!getSetting("soundEnabled")) return;
  if (!contextActivated) return;
  engine?.play(event);
}

function onAgentFound(_payload: AgentFoundPayload): void {
  playIfEnabled("agent_found");
}

function onAgentLost(payload: AgentLostPayload): void {
  agentPreviousStatus.delete(payload.id);
  playIfEnabled("agent_lost");
}

function onAgentStateChanged(payload: AgentStateChangedPayload): void {
  const { id, status } = payload.agent;
  const previous = agentPreviousStatus.get(id);

  // Only play on actual status transition
  if (previous === status) return;

  agentPreviousStatus.set(id, status);

  const soundEvent = STATUS_SOUND_MAP[status];
  if (soundEvent) {
    playIfEnabled(soundEvent);
  }
}

export async function initSoundBridge(): Promise<void> {
  if (engine) return;

  engine = new SoundEngine();

  // Lazy AudioContext activation via user gesture (browser autoplay policy)
  document.addEventListener("click", handleUserGesture);
  document.addEventListener("keydown", handleUserGesture);

  try {
    const { listen } = await import("@tauri-apps/api/event");

    const u1 = await listen<AgentFoundPayload>(
      TAURI_EVENTS.AGENT_FOUND,
      (event) => onAgentFound(event.payload),
    );

    const u2 = await listen<AgentLostPayload>(
      TAURI_EVENTS.AGENT_LOST,
      (event) => onAgentLost(event.payload),
    );

    const u3 = await listen<AgentStateChangedPayload>(
      TAURI_EVENTS.AGENT_STATE_CHANGED,
      (event) => onAgentStateChanged(event.payload),
    );

    unlisteners = [u1, u2, u3];
  } catch {
    // Tauri not available (browser dev mode) — no events to listen
  }
}

export function destroySoundBridge(): void {
  for (const unlisten of unlisteners) {
    unlisten();
  }
  unlisteners = [];

  document.removeEventListener("click", handleUserGesture);
  document.removeEventListener("keydown", handleUserGesture);

  agentPreviousStatus = new Map();
  contextActivated = false;

  engine?.destroy();
  engine = null;
}
