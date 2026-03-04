// Idle zone manager — assigns agents to rest zones and rotates them on timer
// Zone capacity is respected; agents move to a different zone after 10-30s

import type { GridPosition, Zone, ZoneType } from "$lib/types/office";

/** Minimum idle dwell time in milliseconds */
const MIN_IDLE_MS = 10_000;

/** Maximum idle dwell time in milliseconds */
const MAX_IDLE_MS = 30_000;

/** Animation associated with each zone type */
const ZONE_ANIMATION: Record<ZoneType, string> = {
  water_cooler: "drinking",
  kitchen: "coffee",
  sofa: "phone",
  meeting_room: "idle_stand",
  standing_desk: "idle_stand",
  bathroom: "idle_stand",
  hr_zone: "idle_stand",
  lounge: "phone",
};

/** Internal zone state managed by this class */
interface IdleZone {
  id: string;
  type: ZoneType;
  position: GridPosition;
  capacity: number;
  currentOccupants: Set<string>;
  animation: string;
}

/** Slot returned to the caller when a zone is assigned */
export interface ZoneAssignment {
  zone: IdleZone;
  slot: GridPosition;
  slotIndex: number;
}

/** Per-agent tracking state */
interface AgentZoneState {
  zoneId: string;
  lastZoneId: string | null;
  rotationTimer: ReturnType<typeof setTimeout> | null;
  onRotate: (() => void) | null;
}

/**
 * Manages idle-zone assignment, capacity enforcement, and automatic rotation.
 * Call setRotationCallback() so the manager can notify the scene when an agent
 * should move to a new zone.
 */
export class IdleZoneManager {
  private readonly zones: Map<string, IdleZone> = new Map();
  private readonly agentState: Map<string, AgentZoneState> = new Map();

  /**
   * Load zones from the office layout.
   * Clears previous zone data on each call.
   */
  loadZones(layoutZones: Zone[]): void {
    this.zones.clear();
    for (const z of layoutZones) {
      this.zones.set(z.id, {
        id: z.id,
        type: z.type,
        position: { ...z.position },
        capacity: z.capacity,
        currentOccupants: new Set(z.currentOccupants),
        animation: ZONE_ANIMATION[z.type],
      });
    }
  }

  /**
   * Assign an agent to an available idle zone.
   * Avoids repeating the agent's last zone if alternatives exist.
   * Returns null if all zones are full.
   *
   * @param agentId - Unique agent identifier
   * @param onRotate - Callback invoked when the agent's idle timer expires
   */
  assignIdleZone(
    agentId: string,
    onRotate?: () => void
  ): ZoneAssignment | null {
    const lastZoneId = this.agentState.get(agentId)?.lastZoneId ?? null;

    // Release any existing assignment first
    this.releaseZone(agentId);

    const available = this.findAvailableZone(agentId, lastZoneId);
    if (available === null) return null;

    const slotIndex = available.currentOccupants.size;
    available.currentOccupants.add(agentId);

    const state: AgentZoneState = {
      zoneId: available.id,
      lastZoneId: lastZoneId,
      rotationTimer: null,
      onRotate: onRotate ?? null,
    };

    if (onRotate !== undefined) {
      const dwellMs = MIN_IDLE_MS + Math.random() * (MAX_IDLE_MS - MIN_IDLE_MS);
      state.rotationTimer = setTimeout(() => {
        this.triggerRotation(agentId);
      }, dwellMs);
    }

    this.agentState.set(agentId, state);

    return {
      zone: available,
      slot: { ...available.position },
      slotIndex,
    };
  }

  /**
   * Release the zone occupied by the agent (e.g. when a task arrives).
   * Cancels any pending rotation timer.
   */
  releaseZone(agentId: string): void {
    const state = this.agentState.get(agentId);
    if (state === undefined) return;

    if (state.rotationTimer !== null) {
      clearTimeout(state.rotationTimer);
    }

    const zone = this.zones.get(state.zoneId);
    if (zone !== undefined) {
      zone.currentOccupants.delete(agentId);
    }

    // Preserve lastZoneId for next assignment
    this.agentState.set(agentId, {
      zoneId: "",
      lastZoneId: state.zoneId,
      rotationTimer: null,
      onRotate: null,
    });
  }

  /**
   * Remove all tracking for the agent (called when agent disconnects).
   */
  removeAgent(agentId: string): void {
    this.releaseZone(agentId);
    this.agentState.delete(agentId);
  }

  /**
   * Return current occupancy counts for all zone types.
   */
  getOccupancy(): Map<ZoneType, { current: number; max: number }> {
    const result = new Map<ZoneType, { current: number; max: number }>();

    for (const zone of this.zones.values()) {
      const existing = result.get(zone.type);
      if (existing !== undefined) {
        existing.current += zone.currentOccupants.size;
        existing.max += zone.capacity;
      } else {
        result.set(zone.type, {
          current: zone.currentOccupants.size,
          max: zone.capacity,
        });
      }
    }

    return result;
  }

  /**
   * Return the animation name for a given zone type.
   */
  getZoneAnimation(zoneType: ZoneType): string {
    return ZONE_ANIMATION[zoneType];
  }

  /**
   * Return the zone type currently occupied by the agent, or null.
   */
  getAgentZoneType(agentId: string): ZoneType | null {
    const state = this.agentState.get(agentId);
    if (state === undefined || state.zoneId === "") return null;
    return this.zones.get(state.zoneId)?.type ?? null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private findAvailableZone(
    _agentId: string,
    avoidZoneId: string | null
  ): IdleZone | null {
    const zoneList = Array.from(this.zones.values());

    // Shuffle for random selection
    for (let i = zoneList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [zoneList[i], zoneList[j]] = [zoneList[j], zoneList[i]];
    }

    // Prefer zones that aren't the last visited
    const preferred = zoneList.filter(
      (z) => z.id !== avoidZoneId && z.currentOccupants.size < z.capacity
    );

    if (preferred.length > 0) return preferred[0];

    // Fall back to any available zone including the last one
    const fallback = zoneList.find(
      (z) => z.currentOccupants.size < z.capacity
    );

    return fallback ?? null;
  }

  private triggerRotation(agentId: string): void {
    const state = this.agentState.get(agentId);
    if (state === undefined) return;

    const callback = state.onRotate;
    // Release so a fresh assignment can be made
    this.releaseZone(agentId);

    if (callback !== null) {
      callback();
    }
  }
}
