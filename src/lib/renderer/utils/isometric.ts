// Isometric coordinate conversion utilities
// Tile dimensions: 128x64 pixels (2:1 ratio), standard 30-degree isometric projection

import type { GridPosition, ScreenPosition } from "$lib/types/office";

/** Half tile width in pixels */
export const TILE_WIDTH = 128;

/** Half tile height in pixels */
export const TILE_HEIGHT = 64;

/** Half-tile horizontal offset for isometric projection */
export const HALF_TILE_W = TILE_WIDTH / 2;

/** Half-tile vertical offset for isometric projection */
export const HALF_TILE_H = TILE_HEIGHT / 2;

/**
 * Convert isometric grid coordinates to screen (pixel) coordinates.
 * The origin (0, 0) maps to screen (0, 0) — the top diamond vertex.
 * Each column shifts right and down by half a tile; each row shifts left and down.
 *
 * @param col - Grid column index
 * @param row - Grid row index
 * @returns Screen pixel position of the tile's top-center vertex
 */
export function isoToScreen(col: number, row: number): ScreenPosition {
  return {
    x: (col - row) * HALF_TILE_W,
    y: (col + row) * HALF_TILE_H,
  };
}

/**
 * Convert screen (pixel) coordinates to isometric grid coordinates.
 * Inverse of isoToScreen — used for mouse picking.
 *
 * @param screenX - Pixel X coordinate relative to scene origin
 * @param screenY - Pixel Y coordinate relative to scene origin
 * @returns Approximate grid position (may be fractional — floor to get tile)
 */
export function screenToIso(screenX: number, screenY: number): GridPosition {
  // Solve the linear system:
  //   x = (col - row) * HALF_TILE_W
  //   y = (col + row) * HALF_TILE_H
  const col = screenX / TILE_WIDTH + screenY / TILE_HEIGHT;
  const row = screenY / TILE_HEIGHT - screenX / TILE_WIDTH;
  return {
    col: Math.floor(col),
    row: Math.floor(row),
  };
}

/**
 * Compute the z-sort depth value for a tile/sprite at the given grid position.
 * Higher depth = rendered later (on top). Uses Manhattan-like sum.
 *
 * @param col - Grid column
 * @param row - Grid row
 * @returns Sort depth integer
 */
export function isoDepth(col: number, row: number): number {
  return col + row;
}
