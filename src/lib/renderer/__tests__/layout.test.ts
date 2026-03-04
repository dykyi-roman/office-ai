// Unit tests for layout JSON structure validation

import { describe, it, expect } from "vitest";
import mediumLayout from "../layouts/medium.json";

describe("test_layout_parsing", () => {
  it("medium layout loads without errors and has required fields", () => {
    expect(mediumLayout).toBeDefined();
    expect(mediumLayout.size).toBe("medium");
    expect(mediumLayout.width).toBe(12);
    expect(mediumLayout.height).toBe(10);
  });

  it("tiles array is non-empty and each tile has col, row, type", () => {
    expect(Array.isArray(mediumLayout.tiles)).toBe(true);
    expect(mediumLayout.tiles.length).toBeGreaterThan(0);

    for (const tile of mediumLayout.tiles) {
      expect(typeof tile.col).toBe("number");
      expect(typeof tile.row).toBe("number");
      expect(typeof tile.type).toBe("string");
      expect(tile.type.length).toBeGreaterThan(0);
    }
  });

  it("furniture array is non-empty and each item has position and type", () => {
    expect(Array.isArray(mediumLayout.furniture)).toBe(true);
    expect(mediumLayout.furniture.length).toBeGreaterThan(0);

    for (const item of mediumLayout.furniture) {
      expect(typeof item.col).toBe("number");
      expect(typeof item.row).toBe("number");
      expect(typeof item.type).toBe("string");
    }
  });

  it("desks array has valid positions", () => {
    expect(Array.isArray(mediumLayout.desks)).toBe(true);
    expect(mediumLayout.desks.length).toBeGreaterThan(0);

    for (const desk of mediumLayout.desks) {
      expect(typeof desk.position.col).toBe("number");
      expect(typeof desk.position.row).toBe("number");
      expect(typeof desk.isOccupied).toBe("boolean");
    }
  });

  it("zones array contains valid zone types", () => {
    const validTypes = [
      "water_cooler",
      "sofa",
      "meeting_room",
      "standing_desk",
      "lounge",
    ];

    expect(Array.isArray(mediumLayout.zones)).toBe(true);
    expect(mediumLayout.zones.length).toBeGreaterThan(0);

    for (const zone of mediumLayout.zones) {
      expect(validTypes).toContain(zone.type);
      expect(typeof zone.capacity).toBe("number");
      expect(zone.capacity).toBeGreaterThan(0);
      expect(Array.isArray(zone.currentOccupants)).toBe(true);
    }
  });

  it("walkableGrid dimensions match layout width and height", () => {
    const grid = mediumLayout.walkableGrid;
    expect(Array.isArray(grid)).toBe(true);
    expect(grid.length).toBe(mediumLayout.height);

    for (const row of grid) {
      expect(row.length).toBe(mediumLayout.width);
    }
  });

  it("walkableGrid contains only boolean values", () => {
    for (const row of mediumLayout.walkableGrid) {
      for (const cell of row) {
        expect(typeof cell).toBe("boolean");
      }
    }
  });

  it("border tiles in walkableGrid are blocked (walls)", () => {
    const grid = mediumLayout.walkableGrid;
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;

    // Top row should be all false (walls) except entrance door
    const entrance = (mediumLayout as Record<string, unknown>).entrance as { col: number } | undefined;
    const entranceCol = entrance?.col ?? -1;
    for (let c = 0; c < cols; c++) {
      if (c === entranceCol) continue;
      expect(grid[0]?.[c]).toBe(false);
    }
    // Left column
    for (let r = 0; r < rows; r++) {
      expect(grid[r]?.[0]).toBe(false);
    }
    // Right column
    for (let r = 0; r < rows; r++) {
      expect(grid[r]?.[cols - 1]).toBe(false);
    }
  });

  it("tile positions are within layout bounds", () => {
    for (const tile of mediumLayout.tiles) {
      expect(tile.col).toBeGreaterThanOrEqual(0);
      expect(tile.col).toBeLessThan(mediumLayout.width);
      expect(tile.row).toBeGreaterThanOrEqual(0);
      expect(tile.row).toBeLessThan(mediumLayout.height);
    }
  });
});
