// Unit tests for DeskManager — desk assignment logic

import { describe, it, expect, beforeEach } from "vitest";
import { DeskManager } from "../DeskManager";
import type { DeskAssignment } from "../../types/office";

/** Build a list of N free desk assignments starting from col=1, row=1 */
function makeDesks(count: number): DeskAssignment[] {
  return Array.from({ length: count }, (_, i) => ({
    agentId: "",
    position: { col: i + 1, row: 1 },
    isOccupied: false,
  }));
}

describe("test_desk_assignment_priority", () => {
  it("flagship agent receives one of the first (priority) desks", () => {
    const manager = new DeskManager();
    const desks = makeDesks(6);
    manager.loadDesks(desks, 2); // first 2 are priority

    const pos = manager.assignDesk("agent-flagship", "flagship");

    // Priority desks are at col 1 and col 2
    expect(pos.col).toBeLessThanOrEqual(2);
  });

  it("senior agent receives a priority desk when available", () => {
    const manager = new DeskManager();
    manager.loadDesks(makeDesks(4), 2);

    const pos = manager.assignDesk("agent-senior", "senior");
    expect(pos.col).toBeLessThanOrEqual(2);
  });

  it("junior agent receives a standard (non-priority) desk", () => {
    const manager = new DeskManager();
    manager.loadDesks(makeDesks(4), 2); // cols 1-2 are priority, 3-4 are standard

    const pos = manager.assignDesk("agent-junior", "junior");
    // Standard desks start at col 3
    expect(pos.col).toBeGreaterThanOrEqual(3);
  });

  it("middle agent falls back to priority desk when all standard desks are taken", () => {
    const manager = new DeskManager();
    manager.loadDesks(makeDesks(3), 2); // 2 priority, 1 standard

    manager.assignDesk("agent-1", "middle"); // takes the one standard desk
    const pos = manager.assignDesk("agent-2", "middle"); // must use priority

    // Should get one of the priority desks
    expect(pos.col).toBeLessThanOrEqual(2);
  });
});

describe("test_desk_release", () => {
  let manager: DeskManager;

  beforeEach(() => {
    manager = new DeskManager();
    manager.loadDesks(makeDesks(4), 2);
  });

  it("released desk becomes available for reassignment", () => {
    manager.assignDesk("agent-a", "flagship");
    manager.releaseDesk("agent-a");

    const pos2 = manager.assignDesk("agent-b", "flagship");
    // Should get one of the priority desks (col 1 or 2)
    expect(pos2.col).toBeLessThanOrEqual(2);
    expect(pos2.row).toBe(1);
  });

  it("getDeskPosition returns null after release", () => {
    manager.assignDesk("agent-x", "senior");
    manager.releaseDesk("agent-x");

    expect(manager.getDeskPosition("agent-x")).toBeNull();
  });

  it("releaseDesk on unknown agent is a no-op", () => {
    expect(() => manager.releaseDesk("nonexistent")).not.toThrow();
  });
});

describe("test_desk_idempotent_assignment", () => {
  it("assigning the same agent twice returns the same desk position", () => {
    const manager = new DeskManager();
    manager.loadDesks(makeDesks(4), 2);

    const pos1 = manager.assignDesk("agent-dup", "senior");
    const pos2 = manager.assignDesk("agent-dup", "senior");

    expect(pos2).toEqual(pos1);
  });
});

describe("getDeskPosition", () => {
  it("returns the assigned desk position for a known agent", () => {
    const manager = new DeskManager();
    manager.loadDesks(makeDesks(4), 2);

    const assigned = manager.assignDesk("agent-z", "middle");
    const lookup = manager.getDeskPosition("agent-z");

    expect(lookup).toEqual(assigned);
  });

  it("returns null for agents with no desk assigned", () => {
    const manager = new DeskManager();
    manager.loadDesks(makeDesks(4), 2);

    expect(manager.getDeskPosition("nobody")).toBeNull();
  });
});

describe("DeskManager — no desks available", () => {
  it("throws when all desks are occupied", () => {
    const manager = new DeskManager();
    manager.loadDesks(makeDesks(2), 1);

    manager.assignDesk("a1", "flagship");
    manager.assignDesk("a2", "junior");

    expect(() => manager.assignDesk("a3", "middle")).toThrow();
  });
});
