// Unit tests for isometric coordinate conversion utilities

import { describe, it, expect } from "vitest";
import {
  isoToScreen,
  screenToIso,
  isoDepth,
  TILE_WIDTH,
  TILE_HEIGHT,
} from "../utils/isometric";

describe("isoToScreen", () => {
  it("test_iso_origin — (0,0) maps to (0,0)", () => {
    const result = isoToScreen(0, 0);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it("test_iso_col_one — col=1, row=0 shifts right and down by half-tile", () => {
    const result = isoToScreen(1, 0);
    expect(result.x).toBe(TILE_WIDTH / 2);
    expect(result.y).toBe(TILE_HEIGHT / 2);
  });

  it("test_iso_row_one — col=0, row=1 shifts left and down by half-tile", () => {
    const result = isoToScreen(0, 1);
    expect(result.x).toBe(-TILE_WIDTH / 2);
    expect(result.y).toBe(TILE_HEIGHT / 2);
  });

  it("test_iso_diagonal — col=1, row=1 has x=0, y=TILE_HEIGHT", () => {
    const result = isoToScreen(1, 1);
    expect(result.x).toBe(0);
    expect(result.y).toBe(TILE_HEIGHT);
  });

  it("test_iso_large_grid — col=10, row=5 produces expected coordinates", () => {
    const result = isoToScreen(10, 5);
    expect(result.x).toBe((10 - 5) * (TILE_WIDTH / 2));
    expect(result.y).toBe((10 + 5) * (TILE_HEIGHT / 2));
  });
});

describe("screenToIso", () => {
  it("test_screen_origin — (0,0) maps to grid (0,0)", () => {
    const result = screenToIso(0, 0);
    expect(result.col).toBe(0);
    expect(result.row).toBe(0);
  });

  it("test_screen_centre_of_tile — centre of tile (1,0) converts back to col=1, row=0", () => {
    const screen = isoToScreen(1, 0);
    // screenToIso floors the result so use the exact screen centre
    const result = screenToIso(screen.x + 0.1, screen.y + 0.1);
    expect(result.col).toBe(1);
    expect(result.row).toBe(0);
  });
});

describe("test_iso_screen_roundtrip", () => {
  it("iso -> screen -> iso produces original grid coordinates", () => {
    const testCases: Array<[number, number]> = [
      [0, 0],
      [3, 2],
      [10, 7],
      [1, 15],
    ];

    for (const [col, row] of testCases) {
      const screen = isoToScreen(col, row);
      // Add small offset to land inside the tile (not on its boundary)
      const back = screenToIso(screen.x + 0.1, screen.y + 0.1);
      expect(back.col).toBe(col);
      expect(back.row).toBe(row);
    }
  });
});

describe("isoDepth", () => {
  it("returns sum of col and row", () => {
    expect(isoDepth(3, 4)).toBe(7);
    expect(isoDepth(0, 0)).toBe(0);
    expect(isoDepth(10, 5)).toBe(15);
  });

  it("higher row produces higher depth for same column", () => {
    expect(isoDepth(5, 2)).toBeLessThan(isoDepth(5, 3));
  });
});
