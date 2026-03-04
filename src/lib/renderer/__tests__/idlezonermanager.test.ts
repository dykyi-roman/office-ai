// Unit tests for IdleZoneManager — zone assignment, capacity, rotation

import { describe, it, expect, beforeEach, vi } from "vitest";
import { IdleZoneManager } from "../IdleZoneManager";
import type { Zone } from "../../types/office";

function makeZones(): Zone[] {
  return [
    {
      id: "wc1",
      type: "water_cooler",
      position: { col: 5, row: 3 },
      capacity: 2,
      currentOccupants: [],
    },
    {
      id: "kitchen1",
      type: "kitchen",
      position: { col: 10, row: 5 },
      capacity: 1,
      currentOccupants: [],
    },
    {
      id: "sofa1",
      type: "sofa",
      position: { col: 3, row: 12 },
      capacity: 3,
      currentOccupants: [],
    },
  ];
}

describe("test_idle_zone_assignment", () => {
  it("assigns an agent to a zone when capacity is available", () => {
    const manager = new IdleZoneManager();
    manager.loadZones(makeZones());

    const result = manager.assignIdleZone("agent-1");

    expect(result).not.toBeNull();
    expect(result?.zone.currentOccupants.has("agent-1")).toBe(true);
  });

  it("occupancy increases after assignment", () => {
    const manager = new IdleZoneManager();
    manager.loadZones(makeZones());

    manager.assignIdleZone("agent-1");
    const occupancy = manager.getOccupancy();

    const total = Array.from(occupancy.values()).reduce(
      (sum, v) => sum + v.current,
      0
    );
    expect(total).toBe(1);
  });
});

describe("test_idle_zone_full", () => {
  it("picks an alternate zone when the preferred zone is full", () => {
    const manager = new IdleZoneManager();
    // Single-capacity kitchen zone + 2-cap water cooler
    manager.loadZones(makeZones());

    // Fill the kitchen zone
    manager.assignIdleZone("agent-1");
    manager.assignIdleZone("agent-2");
    manager.assignIdleZone("agent-3"); // This will pick whichever zone has space

    const occupancy = manager.getOccupancy();
    const totalOccupants = Array.from(occupancy.values()).reduce(
      (sum, v) => sum + v.current,
      0
    );
    expect(totalOccupants).toBe(3);
  });

  it("returns null when all zones are at capacity", () => {
    const manager = new IdleZoneManager();
    // Total capacity: wc1=2, kitchen1=1, sofa1=3 → max 6
    manager.loadZones(makeZones());

    // Exhaust all capacity
    for (let i = 0; i < 6; i++) {
      manager.assignIdleZone(`agent-${i}`);
    }

    // 7th assignment must fail
    const result = manager.assignIdleZone("agent-7");
    expect(result).toBeNull();
  });
});

describe("test_idle_zone_release", () => {
  it("occupancy decreases after release", () => {
    const manager = new IdleZoneManager();
    manager.loadZones(makeZones());

    manager.assignIdleZone("agent-1");
    manager.releaseZone("agent-1");

    const occupancy = manager.getOccupancy();
    const total = Array.from(occupancy.values()).reduce(
      (sum, v) => sum + v.current,
      0
    );
    expect(total).toBe(0);
  });

  it("releasing an unknown agent is a no-op", () => {
    const manager = new IdleZoneManager();
    manager.loadZones(makeZones());

    expect(() => manager.releaseZone("ghost")).not.toThrow();
  });
});

describe("test_idle_rotation_timer", () => {
  it("calls onRotate callback after the dwell timer fires", async () => {
    vi.useFakeTimers();

    const manager = new IdleZoneManager();
    manager.loadZones(makeZones());

    const rotateCb = vi.fn();
    manager.assignIdleZone("agent-1", rotateCb);

    // Fast-forward 31 seconds (beyond MAX_IDLE_MS of 30s)
    vi.advanceTimersByTime(31_000);

    expect(rotateCb).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});

describe("IdleZoneManager — zone animation mapping", () => {
  let manager: IdleZoneManager;

  beforeEach(() => {
    manager = new IdleZoneManager();
    manager.loadZones(makeZones());
  });

  it("water_cooler zone maps to drinking animation", () => {
    expect(manager.getZoneAnimation("water_cooler")).toBe("drinking");
  });

  it("kitchen zone maps to coffee animation", () => {
    expect(manager.getZoneAnimation("kitchen")).toBe("coffee");
  });

  it("sofa zone maps to phone animation", () => {
    expect(manager.getZoneAnimation("sofa")).toBe("phone");
  });

  it("meeting_room zone maps to idle_stand animation", () => {
    expect(manager.getZoneAnimation("meeting_room")).toBe("idle_stand");
  });

  it("standing_desk zone maps to idle_stand animation", () => {
    expect(manager.getZoneAnimation("standing_desk")).toBe("idle_stand");
  });

  it("bathroom zone maps to idle_stand animation", () => {
    expect(manager.getZoneAnimation("bathroom")).toBe("idle_stand");
  });

  it("hr_zone zone maps to idle_stand animation", () => {
    expect(manager.getZoneAnimation("hr_zone")).toBe("idle_stand");
  });

  it("lounge zone maps to phone animation", () => {
    expect(manager.getZoneAnimation("lounge")).toBe("phone");
  });
});

describe("test_auto_transition_task_complete — idle zone removal on task", () => {
  it("removeAgent clears occupancy and state", () => {
    const manager = new IdleZoneManager();
    manager.loadZones(makeZones());

    manager.assignIdleZone("agent-1");
    manager.removeAgent("agent-1");

    const occupancy = manager.getOccupancy();
    const total = Array.from(occupancy.values()).reduce(
      (sum, v) => sum + v.current,
      0
    );
    expect(total).toBe(0);
    expect(manager.getAgentZoneType("agent-1")).toBeNull();
  });
});
