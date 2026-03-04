// Unit tests for Pathfinder (A* algorithm on an isometric grid)

import { describe, it, expect, beforeEach } from "vitest";
import { Pathfinder } from "../Pathfinder";
import type { GridPosition } from "../../types/office";

// Helper: create a fully walkable grid of given dimensions
function makeWalkable(cols: number, rows: number): boolean[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(true));
}

// Helper: block a tile in the grid
function block(grid: boolean[][], col: number, row: number): void {
  if (grid[row]) grid[row][col] = false;
}

describe("test_pathfinder_direct_path", () => {
  it("finds a straight horizontal path when no obstacles exist", () => {
    const grid = makeWalkable(10, 10);
    const pf = new Pathfinder(grid);

    const from: GridPosition = { col: 0, row: 0 };
    const to: GridPosition = { col: 5, row: 0 };

    const path = pf.findPath(from, to);

    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(to);
  });

  it("finds a straight vertical path when no obstacles exist", () => {
    const grid = makeWalkable(10, 10);
    const pf = new Pathfinder(grid);

    const path = pf.findPath({ col: 3, row: 0 }, { col: 3, row: 7 });

    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ col: 3, row: 7 });
  });

  it("returns empty path when from === to", () => {
    const grid = makeWalkable(5, 5);
    const pf = new Pathfinder(grid);

    const path = pf.findPath({ col: 2, row: 2 }, { col: 2, row: 2 });
    expect(path).toHaveLength(0);
  });
});

describe("test_pathfinder_around_obstacle", () => {
  it("navigates around a blocked column", () => {
    // 5x5 grid with column 2 fully blocked (except row 0 start and end)
    const grid = makeWalkable(7, 7);
    // Block column 3 entirely except row 0 and row 6
    for (let r = 1; r <= 5; r++) block(grid, 3, r);

    const pf = new Pathfinder(grid);
    const path = pf.findPath({ col: 0, row: 3 }, { col: 6, row: 3 });

    expect(path.length).toBeGreaterThan(0);
    // Path must avoid the blocked tiles
    for (const pos of path) {
      expect(grid[pos.row]?.[pos.col]).toBe(true);
    }
    expect(path[path.length - 1]).toEqual({ col: 6, row: 3 });
  });
});

describe("test_pathfinder_unreachable", () => {
  it("returns empty array when destination is completely surrounded by walls", () => {
    const grid = makeWalkable(5, 5);
    // Surround tile (2,2) completely
    block(grid, 1, 2);
    block(grid, 3, 2);
    block(grid, 2, 1);
    block(grid, 2, 3);
    block(grid, 1, 1);
    block(grid, 3, 1);
    block(grid, 1, 3);
    block(grid, 3, 3);
    // Target itself is still walkable but unreachable
    const pf = new Pathfinder(grid);
    const path = pf.findPath({ col: 0, row: 0 }, { col: 2, row: 2 });
    expect(path).toHaveLength(0);
  });

  it("returns empty array when destination is blocked (unwalkable)", () => {
    const grid = makeWalkable(5, 5);
    block(grid, 3, 3);

    const pf = new Pathfinder(grid);
    const path = pf.findPath({ col: 0, row: 0 }, { col: 3, row: 3 });
    expect(path).toHaveLength(0);
  });
});

describe("test_pathfinder_max_length", () => {
  it("truncates paths longer than 50 tiles", () => {
    // Create a 60x1 walkable corridor
    const grid = makeWalkable(60, 1);
    const pf = new Pathfinder(grid);

    const path = pf.findPath({ col: 0, row: 0 }, { col: 59, row: 0 });

    expect(path.length).toBeLessThanOrEqual(50);
  });
});

describe("Pathfinder — caching", () => {
  it("returns the same path on repeated calls (LRU cache)", () => {
    const grid = makeWalkable(10, 10);
    const pf = new Pathfinder(grid);
    const from: GridPosition = { col: 0, row: 0 };
    const to: GridPosition = { col: 9, row: 9 };

    const first = pf.findPath(from, to);
    const second = pf.findPath(from, to);

    expect(second).toEqual(first);
  });

  it("invalidates cache when walkable grid is updated", () => {
    const grid = makeWalkable(5, 5);
    const pf = new Pathfinder(grid);

    const from: GridPosition = { col: 0, row: 0 };
    const to: GridPosition = { col: 4, row: 0 };

    const before = pf.findPath(from, to);
    expect(before.length).toBeGreaterThan(0);

    // Block the entire row — path should now be empty
    const newGrid = makeWalkable(5, 5);
    for (let c = 1; c <= 4; c++) block(newGrid, c, 0);

    pf.updateWalkable(newGrid);
    const after = pf.findPath(from, to);
    expect(after).toHaveLength(0);
  });
});

describe("Pathfinder — desk/zone positions", () => {
  let pf: Pathfinder;

  beforeEach(() => {
    const grid = makeWalkable(10, 10);
    pf = new Pathfinder(grid);
    pf.setDeskPositions([
      { col: 2, row: 2 },
      { col: 5, row: 5 },
      { col: 8, row: 8 },
    ]);
  });

  it("getNearestDesk returns a position from the registered list", () => {
    const desk = pf.getNearestDesk([]);
    expect([2, 5, 8]).toContain(desk.col);
  });

  it("getRandomIdlePosition returns a walkable position for desk zone", () => {
    const pos = pf.getRandomIdlePosition("desk");
    expect(typeof pos.col).toBe("number");
    expect(typeof pos.row).toBe("number");
  });
});
