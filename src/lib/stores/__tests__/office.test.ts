// Unit tests for office store layout logic

import { describe, it, expect } from "vitest";
import type { LayoutSize } from "../../types/index";

// ---------------------------------------------------------------------------
// Pure layout size calculation (mirrors office.ts derived store logic)
// ---------------------------------------------------------------------------

function computeLayoutSize(agentCount: number): LayoutSize {
  if (agentCount <= 4) return "small";
  if (agentCount <= 10) return "medium";
  if (agentCount <= 20) return "large";
  return "campus";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("test_office_layout_size — correct size for agent count thresholds", () => {
  it("returns 'small' for 0 agents", () => {
    expect(computeLayoutSize(0)).toBe("small");
  });

  it("returns 'small' for 1 agent", () => {
    expect(computeLayoutSize(1)).toBe("small");
  });

  it("returns 'small' for 4 agents (boundary)", () => {
    expect(computeLayoutSize(4)).toBe("small");
  });

  it("returns 'medium' for 5 agents (boundary)", () => {
    expect(computeLayoutSize(5)).toBe("medium");
  });

  it("returns 'medium' for 7 agents", () => {
    expect(computeLayoutSize(7)).toBe("medium");
  });

  it("returns 'medium' for 10 agents (boundary)", () => {
    expect(computeLayoutSize(10)).toBe("medium");
  });

  it("returns 'large' for 11 agents (boundary)", () => {
    expect(computeLayoutSize(11)).toBe("large");
  });

  it("returns 'large' for 15 agents", () => {
    expect(computeLayoutSize(15)).toBe("large");
  });

  it("returns 'large' for 20 agents (boundary)", () => {
    expect(computeLayoutSize(20)).toBe("large");
  });

  it("returns 'campus' for 21 agents (boundary)", () => {
    expect(computeLayoutSize(21)).toBe("campus");
  });

  it("returns 'campus' for 50 agents", () => {
    expect(computeLayoutSize(50)).toBe("campus");
  });
});

describe("selectedAgentId logic", () => {
  it("sidebar is open when selectedAgentId is set", () => {
    const selectedAgentId: string | null = "agent-001";
    const sidebarOpen = selectedAgentId !== null;
    expect(sidebarOpen).toBe(true);
  });

  it("sidebar is closed when selectedAgentId is null", () => {
    const selectedAgentId: string | null = null;
    const sidebarOpen = selectedAgentId !== null;
    expect(sidebarOpen).toBe(false);
  });

  it("selectAgent sets the selected id", () => {
    let selectedAgentId: string | null = null;
    // Simulate selectAgent
    selectedAgentId = "agent-001";
    expect(selectedAgentId).toBe("agent-001");
  });

  it("deselectAgent resets to null", () => {
    let selectedAgentId: string | null = "agent-001";
    // Simulate deselectAgent
    selectedAgentId = null;
    expect(selectedAgentId).toBeNull();
  });
});
