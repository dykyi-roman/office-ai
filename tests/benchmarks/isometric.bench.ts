// Performance benchmarks for isometric coordinate conversion
// Measures throughput of isoToScreen, screenToIso, and isoDepth
// Run with: npx vitest bench tests/benchmarks/isometric.bench.ts

import { bench, describe } from "vitest";
import {
  isoToScreen,
  screenToIso,
  isoDepth,
} from "../../src/lib/renderer/utils/isometric";

// ---------------------------------------------------------------------------
// Single-call baseline
// ---------------------------------------------------------------------------

describe("isometric — single conversion baseline", () => {
  bench("isoToScreen single call at origin", () => {
    isoToScreen(0, 0);
  });

  bench("isoToScreen single call at (10, 10)", () => {
    isoToScreen(10, 10);
  });

  bench("screenToIso single call at (0, 0)", () => {
    screenToIso(0, 0);
  });

  bench("isoDepth single call", () => {
    isoDepth(5, 5);
  });
});

// ---------------------------------------------------------------------------
// Batch: 100 conversions (typical frame workload for a 10x10 viewport region)
// ---------------------------------------------------------------------------

describe("isometric — 100 conversions per call", () => {
  bench("isoToScreen × 100", () => {
    for (let i = 0; i < 100; i++) {
      isoToScreen(i % 20, (i * 3) % 20);
    }
  });

  bench("screenToIso × 100", () => {
    for (let i = 0; i < 100; i++) {
      screenToIso(i * 64, i * 32);
    }
  });

  bench("isoDepth × 100", () => {
    for (let i = 0; i < 100; i++) {
      isoDepth(i % 20, (i * 2) % 20);
    }
  });
});

// ---------------------------------------------------------------------------
// Batch: full 20x20 grid scan (400 tiles — medium office layout)
// ---------------------------------------------------------------------------

describe("isometric — full 20x20 grid scan", () => {
  bench("isoToScreen for entire 20×20 grid (400 tiles)", () => {
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 20; col++) {
        isoToScreen(col, row);
      }
    }
  });

  bench("isoDepth for entire 20×20 grid (z-sort)", () => {
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 20; col++) {
        isoDepth(col, row);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip: isoToScreen → screenToIso (20 agents × 60fps mock)
// ---------------------------------------------------------------------------

describe("isometric — agent position round-trip", () => {
  const agentPositions = Array.from({ length: 20 }, (_, i) => ({
    col: (i * 3) % 20,
    row: (i * 7) % 20,
  }));

  bench("isoToScreen → screenToIso round-trip for 20 agents", () => {
    for (const { col, row } of agentPositions) {
      const screen = isoToScreen(col, row);
      screenToIso(screen.x, screen.y);
    }
  });
});

// ---------------------------------------------------------------------------
// Large grid: 80x80 (campus layout)
// ---------------------------------------------------------------------------

describe("isometric — 80×80 campus grid scan", () => {
  bench("isoToScreen for entire 80×80 grid (6400 tiles)", () => {
    for (let row = 0; row < 80; row++) {
      for (let col = 0; col < 80; col++) {
        isoToScreen(col, row);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed workload: simultaneous coordinate queries (simulates agent tick)
// ---------------------------------------------------------------------------

describe("isometric — mixed workload (1 agent vs 20 agents)", () => {
  bench("1 agent: isoToScreen + screenToIso + isoDepth", () => {
    const screen = isoToScreen(5, 3);
    screenToIso(screen.x, screen.y);
    isoDepth(5, 3);
  });

  bench("20 agents: isoToScreen + screenToIso + isoDepth each", () => {
    for (let i = 0; i < 20; i++) {
      const col = (i * 3) % 20;
      const row = (i * 7) % 20;
      const screen = isoToScreen(col, row);
      screenToIso(screen.x, screen.y);
      isoDepth(col, row);
    }
  });
});
