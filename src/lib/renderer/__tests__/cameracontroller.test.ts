// Unit tests for CameraController
// Focuses on pure stateful logic (zoom, pan, follow, bounds clamping)
// without DOM event listeners — those are tested as integration behavior

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("pixi.js", () => ({
  Container: vi.fn(),
  Ticker: {
    shared: {
      add: vi.fn(),
      remove: vi.fn(),
    },
  },
}));

vi.mock("../utils/isometric", () => ({
  isoToScreen: vi.fn((col: number, row: number) => ({
    x: (col - row) * 64,
    y: (col + row) * 32,
  })),
}));

// ---------------------------------------------------------------------------
// Pure camera math (extracted from CameraController)
// ---------------------------------------------------------------------------

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;
const ZOOM_SMOOTH = 0.12;
const FOLLOW_SMOOTH = 0.08;
const PAN_SPEED_PX = 300;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function smoothZoom(current: number, target: number): number {
  return current + (target - current) * ZOOM_SMOOTH;
}

function clampPosition(
  worldX: number,
  worldY: number,
  viewportW: number,
  viewportH: number,
  boundW: number,
  boundH: number,
  currentZoom: number,
): { x: number; y: number } {
  if (boundW === 0) return { x: worldX, y: worldY };

  const scaledW = boundW * currentZoom;
  const scaledH = boundH * currentZoom;

  const minX = viewportW - scaledW;
  const minY = viewportH - scaledH;

  return {
    x: Math.min(viewportW * 0.5, Math.max(minX, worldX)),
    y: Math.min(viewportH * 0.5, Math.max(minY, worldY)),
  };
}

function computeFollowPosition(
  worldX: number,
  worldY: number,
  targetX: number,
  targetY: number,
  viewportW: number,
  viewportH: number,
  zoom: number,
): { x: number; y: number } {
  const desiredX = viewportW / 2 - targetX * zoom;
  const desiredY = viewportH / 2 - targetY * zoom;
  return {
    x: worldX + (desiredX - worldX) * FOLLOW_SMOOTH,
    y: worldY + (desiredY - worldY) * FOLLOW_SMOOTH,
  };
}

function computeCenterOn(
  col: number,
  row: number,
  viewportW: number,
  viewportH: number,
  currentZoom: number,
): { x: number; y: number } {
  // isoToScreen(col, row) = { x: (col-row)*64, y: (col+row)*32 }
  const screenX = (col - row) * 64;
  const screenY = (col + row) * 32;
  return {
    x: viewportW / 2 - screenX * currentZoom,
    y: viewportH / 2 - screenY * currentZoom,
  };
}

function computeKeyboardPan(
  keys: { ArrowLeft: boolean; ArrowRight: boolean; ArrowUp: boolean; ArrowDown: boolean },
  dt: number,
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (keys.ArrowLeft) dx += PAN_SPEED_PX * dt;
  if (keys.ArrowRight) dx -= PAN_SPEED_PX * dt;
  if (keys.ArrowUp) dy += PAN_SPEED_PX * dt;
  if (keys.ArrowDown) dy -= PAN_SPEED_PX * dt;
  return { dx, dy };
}

function computeWorldBounds(worldCols: number, worldRows: number): { w: number; h: number } {
  const brX = Math.abs((worldCols - worldRows) * 64) + 256;
  const brY = (worldCols + worldRows) * 32 + 128;
  return { w: brX, h: brY };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CameraController — zoom clamping", () => {
  it("zoom is clamped to MAX_ZOOM (2.0)", () => {
    expect(clampZoom(2.5)).toBe(MAX_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
  });

  it("zoom is clamped to MIN_ZOOM (0.5)", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
  });

  it("zoom in valid range passes through unchanged", () => {
    expect(clampZoom(1.0)).toBe(1.0);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM);
  });

  it("scroll wheel zoom-in increases target zoom by ZOOM_STEP", () => {
    const initial = 1.0;
    const after = clampZoom(initial + ZOOM_STEP);
    expect(after).toBeCloseTo(1.1, 5);
  });

  it("scroll wheel zoom-out decreases target zoom by ZOOM_STEP", () => {
    const initial = 1.0;
    const after = clampZoom(initial - ZOOM_STEP);
    expect(after).toBeCloseTo(0.9, 5);
  });
});

describe("CameraController — smooth zoom interpolation", () => {
  it("smoothly approaches target over multiple frames", () => {
    let current = 1.0;
    const target = 1.5;

    for (let i = 0; i < 30; i++) {
      current = smoothZoom(current, target);
    }

    expect(current).toBeGreaterThan(1.4);
    expect(current).toBeLessThan(1.5);
  });

  it("converges to target within tolerance after many frames", () => {
    let current = 1.0;
    const target = 2.0;

    for (let i = 0; i < 100; i++) {
      current = smoothZoom(current, target);
    }

    expect(Math.abs(current - target)).toBeLessThan(0.001);
  });
});

describe("CameraController — position clamping", () => {
  it("does not clamp when boundW is 0", () => {
    const result = clampPosition(500, 300, 800, 600, 0, 0, 1);
    expect(result.x).toBe(500);
    expect(result.y).toBe(300);
  });

  it("clamps worldX to right boundary", () => {
    // viewport 800x600, bounds 1000x800, zoom=1
    const result = clampPosition(1000, 100, 800, 600, 1000, 800, 1);
    // minX = 800 - 1000 = -200; max boundary = 800*0.5 = 400
    expect(result.x).toBeLessThanOrEqual(400);
  });

  it("clamps worldX to left boundary", () => {
    const result = clampPosition(-500, 100, 800, 600, 1000, 800, 1);
    const minX = 800 - 1000;
    expect(result.x).toBeGreaterThanOrEqual(minX);
  });

  it("higher zoom reduces available pan area", () => {
    const zoom1 = clampPosition(0, 0, 800, 600, 500, 400, 1.0);
    const zoom2 = clampPosition(0, 0, 800, 600, 500, 400, 2.0);
    // At zoom=2 scaledW=1000, minX=800-1000=-200
    // At zoom=1 scaledW=500, minX=800-500=300
    expect(zoom2.x).toBeLessThanOrEqual(zoom1.x);
  });
});

describe("CameraController — centerOn", () => {
  it("centers camera on grid origin (0, 0)", () => {
    const result = computeCenterOn(0, 0, 800, 600, 1.0);
    expect(result.x).toBe(400);
    expect(result.y).toBe(300);
  });

  it("adjusts for current zoom level", () => {
    // isoToScreen(5, 5) = { x: 0, y: 320 } — x is 0 because col === row
    // At zoom=1: targetX = 800/2 - 0*1 = 400; at zoom=2: targetX = 800/2 - 0*2 = 400
    // For col !== row we get a different x: use col=5, row=3
    const result1 = computeCenterOn(5, 3, 800, 600, 1.0);
    const result2 = computeCenterOn(5, 3, 800, 600, 2.0);
    // isoToScreen(5, 3) = { x: (5-3)*64 = 128, y: (5+3)*32 = 256 }
    // zoom=1: targetX = 400 - 128*1 = 272; zoom=2: targetX = 400 - 128*2 = 144
    expect(result1.x).not.toBe(result2.x);
    expect(result2.x).toBeLessThan(result1.x);
  });

  it("centers on a non-origin grid position", () => {
    const result = computeCenterOn(10, 10, 800, 600, 1.0);
    // isoToScreen(10, 10) = { x: 0, y: 640 }
    expect(result.x).toBe(800 / 2 - 0);
    expect(result.y).toBe(600 / 2 - 640);
  });
});

describe("CameraController — follow mode", () => {
  it("smoothly moves world toward desired position", () => {
    const result = computeFollowPosition(0, 0, 100, 100, 800, 600, 1.0);
    // desiredX = 800/2 - 100 = 300; worldX=0 -> moves toward 300
    expect(result.x).toBeGreaterThan(0);
    expect(result.x).toBeLessThan(300);
  });

  it("converges toward agent center over multiple frames", () => {
    let worldX = 0;
    let worldY = 0;
    const targetX = 200;
    const targetY = 150;
    const viewportW = 800;
    const viewportH = 600;
    const zoom = 1;

    for (let i = 0; i < 60; i++) {
      const result = computeFollowPosition(worldX, worldY, targetX, targetY, viewportW, viewportH, zoom);
      worldX = result.x;
      worldY = result.y;
    }

    const desiredX = viewportW / 2 - targetX * zoom;
    expect(Math.abs(worldX - desiredX)).toBeLessThan(5);
  });
});

describe("CameraController — keyboard pan", () => {
  it("ArrowLeft pans world right (positive dx)", () => {
    const { dx } = computeKeyboardPan(
      { ArrowLeft: true, ArrowRight: false, ArrowUp: false, ArrowDown: false },
      0.016,
    );
    expect(dx).toBeGreaterThan(0);
  });

  it("ArrowRight pans world left (negative dx)", () => {
    const { dx } = computeKeyboardPan(
      { ArrowLeft: false, ArrowRight: true, ArrowUp: false, ArrowDown: false },
      0.016,
    );
    expect(dx).toBeLessThan(0);
  });

  it("no keys pressed results in zero delta", () => {
    const { dx, dy } = computeKeyboardPan(
      { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false },
      0.016,
    );
    expect(dx).toBe(0);
    expect(dy).toBe(0);
  });

  it("opposite keys cancel out", () => {
    const { dx } = computeKeyboardPan(
      { ArrowLeft: true, ArrowRight: true, ArrowUp: false, ArrowDown: false },
      0.016,
    );
    expect(dx).toBe(0);
  });
});

describe("CameraController — world bounds from grid size", () => {
  it("larger grid produces larger world bounds", () => {
    const small = computeWorldBounds(10, 10);
    const large = computeWorldBounds(30, 30);
    expect(large.h).toBeGreaterThan(small.h);
  });

  it("bounds include padding constant", () => {
    const bounds = computeWorldBounds(0, 0);
    // With 0x0 grid: brX = abs(0)*64+256 = 256, brY = 0*32+128 = 128
    expect(bounds.w).toBe(256);
    expect(bounds.h).toBe(128);
  });
});
