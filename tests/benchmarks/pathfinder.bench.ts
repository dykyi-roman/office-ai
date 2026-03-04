// Performance benchmarks for A* Pathfinder
// Targets: < 500ms total for 20 agents on a 20x20 grid
// Run with: npx vitest bench tests/benchmarks/pathfinder.bench.ts

import { bench, describe } from "vitest";
import { Pathfinder } from "../../src/lib/renderer/Pathfinder";
import type { GridPosition } from "../../src/lib/types/office";

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

function makeWalkable(cols: number, rows: number): boolean[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(true));
}

function makeGridWithObstacles(cols: number, rows: number): boolean[][] {
  const grid = makeWalkable(cols, rows);
  // Block 20% of interior tiles as obstacles (deterministic pattern)
  for (let r = 2; r < rows - 2; r += 5) {
    for (let c = 2; c < cols - 2; c += 3) {
      if (grid[r]) {
        grid[r][c] = false;
      }
    }
  }
  return grid;
}

function cornerToCorner(cols: number, rows: number): [GridPosition, GridPosition] {
  return [
    { col: 0, row: 0 },
    { col: cols - 1, row: rows - 1 },
  ];
}

// ---------------------------------------------------------------------------
// 20x20 grid benchmarks
// ---------------------------------------------------------------------------

describe("Pathfinder — 20x20 grid", () => {
  const cols = 20;
  const rows = 20;
  const grid = makeWalkable(cols, rows);
  const pf = new Pathfinder(grid);
  const [from, to] = cornerToCorner(cols, rows);

  bench("single path: corner-to-corner (cached after first run)", () => {
    pf.findPath(from, to);
  });

  bench("20 unique paths across the grid (no cache)", () => {
    const pf20 = new Pathfinder(makeWalkable(cols, rows));
    for (let i = 0; i < 20; i++) {
      const f: GridPosition = { col: i % cols, row: 0 };
      const t: GridPosition = { col: (cols - 1 - i) % cols, row: rows - 1 };
      pf20.findPath(f, t);
    }
  });

  bench("20 paths with obstacles", () => {
    const pfObs = new Pathfinder(makeGridWithObstacles(cols, rows));
    for (let i = 0; i < 20; i++) {
      const f: GridPosition = { col: 0, row: i % rows };
      const t: GridPosition = { col: cols - 1, row: (rows - 1 - i) % rows };
      pfObs.findPath(f, t);
    }
  });
});

// ---------------------------------------------------------------------------
// 40x40 grid benchmarks
// ---------------------------------------------------------------------------

describe("Pathfinder — 40x40 grid", () => {
  const cols = 40;
  const rows = 40;
  const grid = makeWalkable(cols, rows);
  const [from, to] = cornerToCorner(cols, rows);

  bench("single path: corner-to-corner", () => {
    const pf = new Pathfinder(grid);
    pf.findPath(from, to);
  });

  bench("20 unique paths across 40x40 grid", () => {
    const pf = new Pathfinder(makeWalkable(cols, rows));
    for (let i = 0; i < 20; i++) {
      const f: GridPosition = { col: i % cols, row: 0 };
      const t: GridPosition = { col: (cols - 1 - i) % cols, row: rows - 1 };
      pf.findPath(f, t);
    }
  });
});

// ---------------------------------------------------------------------------
// 80x80 grid benchmarks
// ---------------------------------------------------------------------------

describe("Pathfinder — 80x80 grid", () => {
  const cols = 80;
  const rows = 80;
  const grid = makeWalkable(cols, rows);
  const [from, to] = cornerToCorner(cols, rows);

  bench("single path: corner-to-corner on 80x80", () => {
    const pf = new Pathfinder(grid);
    pf.findPath(from, to);
  });

  bench("20 unique paths across 80x80 grid", () => {
    const pf = new Pathfinder(makeWalkable(cols, rows));
    for (let i = 0; i < 20; i++) {
      const f: GridPosition = { col: i % cols, row: 0 };
      const t: GridPosition = { col: (cols - 1 - i) % cols, row: rows - 1 };
      pf.findPath(f, t);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache effectiveness
// ---------------------------------------------------------------------------

describe("Pathfinder — LRU cache", () => {
  const pf = new Pathfinder(makeWalkable(20, 20));
  const from: GridPosition = { col: 0, row: 0 };
  const to: GridPosition = { col: 19, row: 19 };

  // Warm up the cache
  pf.findPath(from, to);

  bench("repeated identical path lookup (cache hit)", () => {
    pf.findPath(from, to);
  });

  bench("cache miss: unique random paths", () => {
    const pfFresh = new Pathfinder(makeWalkable(20, 20));
    // Enumerate all possible start-to-end combinations to force misses
    pfFresh.findPath({ col: 0, row: 0 }, { col: 19, row: 19 });
    pfFresh.findPath({ col: 1, row: 0 }, { col: 18, row: 19 });
    pfFresh.findPath({ col: 2, row: 0 }, { col: 17, row: 19 });
    pfFresh.findPath({ col: 3, row: 0 }, { col: 16, row: 19 });
    pfFresh.findPath({ col: 4, row: 0 }, { col: 15, row: 19 });
  });
});

// ---------------------------------------------------------------------------
// Pathfinder with dead ends (worst-case exploration)
// ---------------------------------------------------------------------------

describe("Pathfinder — worst-case unreachable target", () => {
  const grid = makeWalkable(20, 20);
  // Completely block row 10 (no path from top half to bottom half)
  for (let c = 0; c < 20; c++) {
    if (grid[10]) grid[10][c] = false;
  }

  bench("unreachable destination on 20x20 (full exploration)", () => {
    const pf = new Pathfinder(grid);
    pf.findPath({ col: 0, row: 0 }, { col: 19, row: 19 });
  });
});
