// Desk assignment manager
// Expert/Senior agents receive priority (lead) desks; Middle/Junior receive standard desks

import type { GridPosition, DeskAssignment } from "$lib/types/office";
import type { Tier } from "$lib/types/agent";

/** Desk record stored in the manager */
interface DeskRecord {
  position: GridPosition;
  tier: "priority" | "standard";
  agentId: string | null;
}

/**
 * Manages desk assignments for agents.
 * Priority desks are reserved for expert and senior agents.
 * Standard desks are used by middle and junior agents.
 * All non-assigned priority desks can overflow to senior when standard desks run out.
 */
export class DeskManager {
  /** All registered desks */
  private readonly desks: DeskRecord[] = [];

  /** Agent-ID → desk-index mapping for quick lookup */
  private readonly agentDesk: Map<string, number> = new Map();

  /**
   * Load desk positions from a layout's desk-assignment list.
   * Priority desks must be explicitly marked in the layout (agentId is null, isOccupied false).
   * The first N desks can be designated "priority" by passing `priorityCount`.
   *
   * @param assignments - Raw desk list from OfficeLayout.desks
   * @param priorityCount - How many of the first desks are priority desks (default: 2)
   */
  loadDesks(assignments: DeskAssignment[], priorityCount = 2): void {
    this.desks.length = 0;
    this.agentDesk.clear();

    assignments.forEach((desk, idx) => {
      this.desks.push({
        position: { ...desk.position },
        tier: idx < priorityCount ? "priority" : "standard",
        agentId: desk.isOccupied ? desk.agentId : null,
      });

      if (desk.isOccupied) {
        this.agentDesk.set(desk.agentId, idx);
      }
    });
  }

  /**
   * Assign the nearest free desk appropriate for the given tier.
   * Expert and senior agents get priority desks first; if none remain they
   * fall back to standard desks. Middle and junior always use standard desks.
   *
   * @param agentId - Unique agent identifier
   * @param tier - Agent tier determining desk priority
   * @returns Grid position of the assigned desk
   * @throws Error if no desks are available
   */
  assignDesk(agentId: string, tier: Tier): GridPosition {
    if (this.agentDesk.has(agentId)) {
      const existing = this.desks[this.agentDesk.get(agentId)!];
      return { ...existing.position };
    }

    const wantsPriority = tier === "expert" || tier === "senior";

    // First pass: preferred tier
    const primaryIdx = this.findFreeDesk(wantsPriority ? "priority" : "standard");
    if (primaryIdx !== -1) {
      return this.occupyDesk(primaryIdx, agentId);
    }

    // Second pass: fall back to the other tier
    const fallbackIdx = this.findFreeDesk(wantsPriority ? "standard" : "priority");
    if (fallbackIdx !== -1) {
      return this.occupyDesk(fallbackIdx, agentId);
    }

    throw new Error(`No available desks for agent ${agentId} (tier: ${tier})`);
  }

  /**
   * Release the desk occupied by the given agent.
   * No-op if the agent has no desk assigned.
   */
  releaseDesk(agentId: string): void {
    const idx = this.agentDesk.get(agentId);
    if (idx === undefined) return;

    this.desks[idx].agentId = null;
    this.agentDesk.delete(agentId);
  }

  /**
   * Return the grid position of the desk assigned to the given agent,
   * or null if the agent has no desk.
   */
  getDeskPosition(agentId: string): GridPosition | null {
    const idx = this.agentDesk.get(agentId);
    if (idx === undefined) return null;
    return { ...this.desks[idx].position };
  }

  /**
   * Return all desk positions as an array (used by Pathfinder.setDeskPositions).
   */
  getAllDeskPositions(): GridPosition[] {
    return this.desks.map((d) => ({ ...d.position }));
  }

  /**
   * Return true if the given grid position is occupied by a desk.
   */
  isDeskPosition(col: number, row: number): boolean {
    return this.desks.some((d) => d.position.col === col && d.position.row === row);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private findFreeDesk(deskTier: "priority" | "standard"): number {
    const freeIndices: number[] = [];
    for (let i = 0; i < this.desks.length; i++) {
      if (this.desks[i].tier === deskTier && this.desks[i].agentId === null) {
        freeIndices.push(i);
      }
    }
    if (freeIndices.length === 0) return -1;
    return freeIndices[Math.floor(Math.random() * freeIndices.length)];
  }

  private occupyDesk(idx: number, agentId: string): GridPosition {
    this.desks[idx].agentId = agentId;
    this.agentDesk.set(agentId, idx);
    return { ...this.desks[idx].position };
  }
}
