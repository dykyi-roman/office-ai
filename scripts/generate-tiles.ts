/**
 * Office Tileset Generator
 *
 * Generates isometric office tiles at 128x64 pixels (2:1 iso ratio).
 * Outputs a single spritesheet PNG + PixiJS-compatible JSON atlas.
 *
 * Output: src/assets/tiles/office-tileset.png + office-tileset.json
 */

import { createCanvas, Canvas, SKRSContext2D } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TILE_W = 128;
const TILE_H = 64;
const CELL_H = 128;
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, 'src/assets/tiles');

// Tiles per row in spritesheet
const TILES_PER_ROW = 6;

// ---------------------------------------------------------------------------
// Tile definitions
// ---------------------------------------------------------------------------

interface TileDef {
  name: string;
  draw: (ctx: SKRSContext2D, ox: number, oy: number) => void;
}

// ---------------------------------------------------------------------------
// Isometric drawing helpers
// ---------------------------------------------------------------------------

/**
 * Convert isometric tile-local coordinates to screen coordinates.
 * Iso origin is at the top center of the tile bounding box.
 * The diamond goes: top (cx,0), right (tw,th/2), bottom (cx,th), left (0,th/2)
 */
function isoPoint(ox: number, oy: number, u: number, v: number): [number, number] {
  const cx = ox + TILE_W / 2;
  const cy = oy;
  const x = cx + (u - v) * (TILE_W / 2);
  const y = cy + (u + v) * (TILE_H / 2);
  return [x, y];
}

/** Draw the base isometric diamond floor tile */
function drawIsoDiamond(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  fillColor: string,
  strokeColor: string,
  strokeWidth: number = 1
): void {
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [lx, ly] = isoPoint(ox, oy, 0, 1);

  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(rx, ry);
  ctx.lineTo(bx, by);
  ctx.lineTo(lx, ly);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}

/** Draw a vertical left-facing iso wall face */
function drawIsoLeftWall(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  height: number,
  fillColor: string,
  strokeColor: string
): void {
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx, ly - height);
  ctx.lineTo(bx, by - height);
  ctx.lineTo(bx, by);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Draw a vertical right-facing iso wall face */
function drawIsoRightWall(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  height: number,
  fillColor: string,
  strokeColor: string
): void {
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  ctx.beginPath();
  ctx.moveTo(rx, ry);
  ctx.lineTo(rx, ry - height);
  ctx.lineTo(bx, by - height);
  ctx.lineTo(bx, by);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Draw iso top face (flat rectangle on top) */
function drawIsoTop(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  height: number,
  fillColor: string,
  strokeColor: string
): void {
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  ctx.beginPath();
  ctx.moveTo(tx, ty - height);
  ctx.lineTo(rx, ry - height);
  ctx.lineTo(bx, by - height);
  ctx.lineTo(lx, ly - height);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Draw a full isometric box (top + left + right faces) */
function drawIsoBox(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  height: number,
  topColor: string,
  leftColor: string,
  rightColor: string,
  strokeColor: string = '#222'
): void {
  drawIsoLeftWall(ctx, ox, oy, height, leftColor, strokeColor);
  drawIsoRightWall(ctx, ox, oy, height, rightColor, strokeColor);
  drawIsoTop(ctx, ox, oy, height, topColor, strokeColor);
}

// ---------------------------------------------------------------------------
// Wood grain pattern helper
// ---------------------------------------------------------------------------

function drawWoodGrain(ctx: SKRSContext2D, ox: number, oy: number): void {
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [lx, ly] = isoPoint(ox, oy, 0, 1);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(rx, ry);
  ctx.lineTo(bx, by);
  ctx.lineTo(lx, ly);
  ctx.closePath();
  ctx.clip();

  ctx.strokeStyle = 'rgba(120,70,20,0.18)';
  ctx.lineWidth = 1.5;
  // Draw diagonal grain lines
  for (let i = -4; i < 8; i++) {
    const t = i / 7;
    const startX = tx + (lx - tx) * t;
    const startY = ty + (ly - ty) * t;
    const endX = rx + (bx - rx) * t;
    const endY = ry + (by - ry) * t;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCarpetPattern(ctx: SKRSContext2D, ox: number, oy: number): void {
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [lx, ly] = isoPoint(ox, oy, 0, 1);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(rx, ry);
  ctx.lineTo(bx, by);
  ctx.lineTo(lx, ly);
  ctx.closePath();
  ctx.clip();

  // Subtle diamond pattern
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const t = i / 4;
    const mx = tx + (bx - tx) * t;
    const my = ty + (by - ty) * t;
    ctx.beginPath();
    ctx.moveTo(mx, my - 4);
    ctx.lineTo(mx + 8, my);
    ctx.lineTo(mx, my + 4);
    ctx.lineTo(mx - 8, my);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Individual tile drawing functions
// ---------------------------------------------------------------------------

function drawFloorWood(ctx: SKRSContext2D, ox: number, oy: number): void {
  drawIsoDiamond(ctx, ox, oy, '#c8874a', '#8b5e2a');
  drawWoodGrain(ctx, ox, oy);
}

function drawFloorCarpet(ctx: SKRSContext2D, ox: number, oy: number): void {
  drawIsoDiamond(ctx, ox, oy, '#5b7fa6', '#3d5978');
  drawCarpetPattern(ctx, ox, oy);
}

function drawFloorTile(ctx: SKRSContext2D, ox: number, oy: number): void {
  drawIsoDiamond(ctx, ox, oy, '#e8e8e8', '#bbb');
  // Tile grout lines
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(rx, ry);
  ctx.lineTo(bx, by);
  ctx.lineTo(lx, ly);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = 'rgba(180,180,180,0.6)';
  ctx.lineWidth = 1;
  const midTopX = (tx + rx) / 2;
  const midTopY = (ty + ry) / 2;
  const midBotX = (lx + bx) / 2;
  const midBotY = (ly + by) / 2;
  ctx.beginPath();
  ctx.moveTo(midTopX, midTopY);
  ctx.lineTo(midBotX, midBotY);
  ctx.stroke();
  const midLeftX = (tx + lx) / 2;
  const midLeftY = (ty + ly) / 2;
  const midRightX = (rx + bx) / 2;
  const midRightY = (ry + by) / 2;
  ctx.beginPath();
  ctx.moveTo(midLeftX, midLeftY);
  ctx.lineTo(midRightX, midRightY);
  ctx.stroke();
  ctx.restore();
}

function drawWallPanelLines(
  ctx: SKRSContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  wallH: number
): void {
  ctx.strokeStyle = 'rgba(90,80,64,0.1)';
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    const lineY = wallH * frac;
    ctx.beginPath();
    ctx.moveTo(x1, y1 - lineY);
    ctx.lineTo(x2, y2 - lineY);
    ctx.stroke();
  }
}

function drawWallBaseboard(
  ctx: SKRSContext2D,
  x1: number, y1: number,
  x2: number, y2: number
): void {
  const h = 4;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2, y2 - h);
  ctx.lineTo(x1, y1 - h);
  ctx.closePath();
  ctx.fillStyle = '#8a7e6e';
  ctx.fill();
}

function drawWall4PaneWindow(
  ctx: SKRSContext2D,
  cx: number, cy: number,
  w: number, h: number
): void {
  // Glass gradient (simple two-tone approximation)
  ctx.fillStyle = '#a8c8e8';
  ctx.fillRect(cx - w / 2, cy, w, h / 2);
  ctx.fillStyle = '#d0e4f4';
  ctx.fillRect(cx - w / 2, cy + h / 2, w, h / 2);

  // Frame
  ctx.strokeStyle = '#5a4e40';
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy, w, h);

  // Cross dividers
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy + h);
  ctx.moveTo(cx - w / 2, cy + h / 2);
  ctx.lineTo(cx + w / 2, cy + h / 2);
  ctx.stroke();
}

function drawWallLeft(ctx: SKRSContext2D, ox: number, oy: number, withWindow = true): void {
  const wallH = 40;
  const stroke = '#7a6e60';

  // Diamond top surface
  drawIsoDiamond(ctx, ox, oy, '#e8e0d0', stroke);

  // Left wall face
  drawIsoLeftWall(ctx, ox, oy, wallH, '#c9bfad', stroke);

  // Top edge (wall thickness)
  drawIsoTop(ctx, ox, oy, wallH, '#e8e0d0', stroke);

  // Baseboard trim
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  drawWallBaseboard(ctx, lx, ly, bx, by);

  // Panel texture lines
  drawWallPanelLines(ctx, lx, ly, bx, by, wallH);

  if (withWindow) {
    // 4-pane window
    const wx = (lx + bx) / 2;
    const wy = (ly + by) / 2 - wallH + 4;
    drawWall4PaneWindow(ctx, wx, wy, 20, 18);
  }
}

function drawWallRight(ctx: SKRSContext2D, ox: number, oy: number, withWindow = true): void {
  const wallH = 40;
  const stroke = '#7a6e60';

  drawIsoDiamond(ctx, ox, oy, '#e8e0d0', stroke);
  drawIsoRightWall(ctx, ox, oy, wallH, '#d8cfc0', stroke);
  drawIsoTop(ctx, ox, oy, wallH, '#e8e0d0', stroke);

  // Baseboard trim
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  drawWallBaseboard(ctx, bx, by, rx, ry);

  // Panel texture lines
  drawWallPanelLines(ctx, bx, by, rx, ry, wallH);

  if (withWindow) {
    // 4-pane window
    const wx = (bx + rx) / 2;
    const wy = (by + ry) / 2 - wallH + 4;
    drawWall4PaneWindow(ctx, wx, wy, 20, 18);
  }
}

function drawWallCorner(ctx: SKRSContext2D, ox: number, oy: number): void {
  const wallH = 40;
  const stroke = '#7a6e60';

  drawIsoDiamond(ctx, ox, oy, '#e8e0d0', stroke);
  drawIsoLeftWall(ctx, ox, oy, wallH, '#c9bfad', stroke);
  drawIsoRightWall(ctx, ox, oy, wallH, '#d8cfc0', stroke);
  drawIsoTop(ctx, ox, oy, wallH, '#e8e0d0', stroke);

  // Baseboards
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  drawWallBaseboard(ctx, lx, ly, bx, by);
  drawWallBaseboard(ctx, bx, by, rx, ry);

  // Panel lines on both faces
  drawWallPanelLines(ctx, lx, ly, bx, by, wallH);
  drawWallPanelLines(ctx, bx, by, rx, ry, wallH);
}

function drawDeskStandard(ctx: SKRSContext2D, ox: number, oy: number): void {
  const deskH = 14;
  const edgeH = 3;
  const surfaceH = deskH + edgeH;

  // Back panel (right iso face — solid beige)
  drawIsoRightWall(ctx, ox, oy, deskH, '#e0d5c0', '#a89880');

  // Front legs — two narrow panels on left iso face with gap between
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const legFrac = 0.22;

  // Left leg panel
  const leg1Ex = lx + (bx - lx) * legFrac;
  const leg1Ey = ly + (by - ly) * legFrac;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(leg1Ex, leg1Ey);
  ctx.lineTo(leg1Ex, leg1Ey - deskH);
  ctx.lineTo(lx, ly - deskH);
  ctx.closePath();
  ctx.fillStyle = '#e0d5c0';
  ctx.fill();
  ctx.strokeStyle = '#a89880';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Right leg panel
  const leg2Sx = lx + (bx - lx) * (1 - legFrac);
  const leg2Sy = ly + (by - ly) * (1 - legFrac);
  ctx.beginPath();
  ctx.moveTo(leg2Sx, leg2Sy);
  ctx.lineTo(bx, by);
  ctx.lineTo(bx, by - deskH);
  ctx.lineTo(leg2Sx, leg2Sy - deskH);
  ctx.closePath();
  ctx.fillStyle = '#e0d5c0';
  ctx.fill();
  ctx.stroke();

  // Tabletop front edge (thin strip across full left face)
  ctx.beginPath();
  ctx.moveTo(lx, ly - deskH);
  ctx.lineTo(bx, by - deskH);
  ctx.lineTo(bx, by - deskH - edgeH);
  ctx.lineTo(lx, ly - deskH - edgeH);
  ctx.closePath();
  ctx.fillStyle = '#c49860';
  ctx.fill();
  ctx.strokeStyle = '#8b5e2a';
  ctx.stroke();

  // Tabletop right edge
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  ctx.beginPath();
  ctx.moveTo(bx, by - deskH);
  ctx.lineTo(rx, ry - deskH);
  ctx.lineTo(rx, ry - deskH - edgeH);
  ctx.lineTo(bx, by - deskH - edgeH);
  ctx.closePath();
  ctx.fillStyle = '#b8915a';
  ctx.fill();
  ctx.stroke();

  // Tabletop surface
  drawIsoTop(ctx, ox, oy, surfaceH, '#d4a96a', '#8b5e2a');

  // Monitor on desk
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.35);
  const sy = ty - surfaceH;
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(tx - 11, sy - 22, 22, 16);
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(tx - 9, sy - 20, 18, 12);
  ctx.fillStyle = '#555';
  ctx.fillRect(tx - 2, sy - 6, 4, 6);
  ctx.fillRect(tx - 5, sy, 10, 2);
  // Keyboard
  ctx.fillStyle = '#ccc';
  const [kx, ky] = isoPoint(ox, oy, 0.5, 0.65);
  ctx.fillRect(kx - 10, ky - surfaceH - 2, 20, 5);
}

function drawDeskStanding(ctx: SKRSContext2D, ox: number, oy: number): void {
  const deskH = 24;
  const edgeH = 3;
  const surfaceH = deskH + edgeH;

  // Two T-shaped legs (dark metal)
  const [cx, cy] = isoPoint(ox, oy, 0.5, 0.5);
  const legPositions: [number, number][] = [[0.25, 0.5], [0.75, 0.5]];
  for (const [lu, lv] of legPositions) {
    const [legX, legY] = isoPoint(ox, oy, lu, lv);
    // Foot (horizontal bar at base)
    const footW = 10;
    ctx.fillStyle = '#333';
    ctx.fillRect(legX - footW / 2, legY - 3, footW, 3);
    // Vertical pole
    ctx.fillRect(legX - 2, legY - deskH, 4, deskH - 3);
  }

  // Tabletop front edge
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  ctx.beginPath();
  ctx.moveTo(lx, ly - deskH);
  ctx.lineTo(bx, by - deskH);
  ctx.lineTo(bx, by - deskH - edgeH);
  ctx.lineTo(lx, ly - deskH - edgeH);
  ctx.closePath();
  ctx.fillStyle = '#b8915a';
  ctx.fill();
  ctx.strokeStyle = '#8b5e2a';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Tabletop right edge
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  ctx.beginPath();
  ctx.moveTo(bx, by - deskH);
  ctx.lineTo(rx, ry - deskH);
  ctx.lineTo(rx, ry - deskH - edgeH);
  ctx.lineTo(bx, by - deskH - edgeH);
  ctx.closePath();
  ctx.fillStyle = '#a07848';
  ctx.fill();
  ctx.stroke();

  // Tabletop surface
  drawIsoTop(ctx, ox, oy, surfaceH, '#c9a05a', '#8b5e2a');

  // Laptop on desk
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.4);
  const sy = ty - surfaceH;
  ctx.fillStyle = '#888';
  ctx.fillRect(tx - 10, sy - 13, 20, 13);
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(tx - 8, sy - 11, 16, 10);
  ctx.fillStyle = '#777';
  ctx.fillRect(tx - 10, sy, 20, 3);
}

function drawDeskLead(ctx: SKRSContext2D, ox: number, oy: number): void {
  const deskH = 14;
  const edgeH = 3;
  const surfaceH = deskH + edgeH;

  // Back panel (right iso face — dark wood)
  drawIsoRightWall(ctx, ox, oy, deskH, '#9a7858', '#6b5540');

  // Front legs — two solid panels on left iso face
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const legFrac = 0.25;

  // Left leg panel
  const leg1Ex = lx + (bx - lx) * legFrac;
  const leg1Ey = ly + (by - ly) * legFrac;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(leg1Ex, leg1Ey);
  ctx.lineTo(leg1Ex, leg1Ey - deskH);
  ctx.lineTo(lx, ly - deskH);
  ctx.closePath();
  ctx.fillStyle = '#9a7858';
  ctx.fill();
  ctx.strokeStyle = '#6b5540';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Right leg panel
  const leg2Sx = lx + (bx - lx) * (1 - legFrac);
  const leg2Sy = ly + (by - ly) * (1 - legFrac);
  ctx.beginPath();
  ctx.moveTo(leg2Sx, leg2Sy);
  ctx.lineTo(bx, by);
  ctx.lineTo(bx, by - deskH);
  ctx.lineTo(leg2Sx, leg2Sy - deskH);
  ctx.closePath();
  ctx.fillStyle = '#9a7858';
  ctx.fill();
  ctx.stroke();

  // Tabletop front edge
  ctx.beginPath();
  ctx.moveTo(lx, ly - deskH);
  ctx.lineTo(bx, by - deskH);
  ctx.lineTo(bx, by - deskH - edgeH);
  ctx.lineTo(lx, ly - deskH - edgeH);
  ctx.closePath();
  ctx.fillStyle = '#a07848';
  ctx.fill();
  ctx.strokeStyle = '#6b5540';
  ctx.stroke();

  // Tabletop right edge
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  ctx.beginPath();
  ctx.moveTo(bx, by - deskH);
  ctx.lineTo(rx, ry - deskH);
  ctx.lineTo(rx, ry - deskH - edgeH);
  ctx.lineTo(bx, by - deskH - edgeH);
  ctx.closePath();
  ctx.fillStyle = '#8b6848';
  ctx.fill();
  ctx.stroke();

  // Tabletop surface (rich dark wood)
  drawIsoTop(ctx, ox, oy, surfaceH, '#b8916a', '#6b5540');

  // Two monitors
  const [t1x, t1y] = isoPoint(ox, oy, 0.35, 0.35);
  const [t2x, t2y] = isoPoint(ox, oy, 0.65, 0.35);
  for (const [mx, my] of [[t1x, t1y], [t2x, t2y]] as [number, number][]) {
    const sy = my - surfaceH;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(mx - 9, sy - 18, 18, 14);
    ctx.fillStyle = '#4fc3f7';
    ctx.fillRect(mx - 7, sy - 16, 14, 11);
    ctx.fillStyle = '#555';
    ctx.fillRect(mx - 1, sy - 4, 3, 4);
  }
  // Gold nameplate
  ctx.fillStyle = '#c9a227';
  const [nx, ny] = isoPoint(ox, oy, 0.5, 0.9);
  ctx.fillRect(nx - 12, ny - surfaceH - 2, 22, 5);
}

function drawChair(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  rotation: 'n' | 's' | 'e' | 'w'
): void {
  // All coordinates via isoPoint for proper isometric alignment
  const [cx, cy] = isoPoint(ox, oy, 0.5, 0.5);

  // --- Star base: 5 spokes on the floor plane ---
  const legR = 0.18;
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const [ex, ey] = isoPoint(ox, oy, 0.5 + Math.cos(a) * legR, 0.5 + Math.sin(a) * legR);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(ex, ey, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Central pole ---
  const poleH = 10;
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - poleH);
  ctx.stroke();

  // --- Seat cushion: small iso diamond elevated by poleH ---
  const sr = 0.15;
  const seatElev = poleH;
  const seatThick = 5;

  const u0 = 0.5 - sr;
  const u1 = 0.5 + sr;
  const v0 = 0.5 - sr;
  const v1 = 0.5 + sr;

  const [stx, sty] = isoPoint(ox, oy, u0, v0); // top
  const [srx, sry] = isoPoint(ox, oy, u1, v0); // right
  const [sbx, sby] = isoPoint(ox, oy, u1, v1); // bottom
  const [slx, sly] = isoPoint(ox, oy, u0, v1); // left

  // Seat left face
  ctx.beginPath();
  ctx.moveTo(slx, sly - seatElev);
  ctx.lineTo(sbx, sby - seatElev);
  ctx.lineTo(sbx, sby - seatElev - seatThick);
  ctx.lineTo(slx, sly - seatElev - seatThick);
  ctx.closePath();
  ctx.fillStyle = '#374151';
  ctx.fill();
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Seat right face
  ctx.beginPath();
  ctx.moveTo(sbx, sby - seatElev);
  ctx.lineTo(srx, sry - seatElev);
  ctx.lineTo(srx, sry - seatElev - seatThick);
  ctx.lineTo(sbx, sby - seatElev - seatThick);
  ctx.closePath();
  ctx.fillStyle = '#2d3748';
  ctx.fill();
  ctx.stroke();

  // Seat top face
  ctx.beginPath();
  ctx.moveTo(stx, sty - seatElev - seatThick);
  ctx.lineTo(srx, sry - seatElev - seatThick);
  ctx.lineTo(sbx, sby - seatElev - seatThick);
  ctx.lineTo(slx, sly - seatElev - seatThick);
  ctx.closePath();
  ctx.fillStyle = '#4a5568';
  ctx.fill();
  ctx.stroke();

  // --- Backrest ---
  const backH = 14;
  const topElev = seatElev + seatThick;
  ctx.fillStyle = '#374151';
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1;

  if (rotation === 'n') {
    ctx.beginPath();
    ctx.moveTo(stx, sty - topElev);
    ctx.lineTo(srx, sry - topElev);
    ctx.lineTo(srx, sry - topElev - backH);
    ctx.lineTo(stx, sty - topElev - backH);
    ctx.closePath();
  } else if (rotation === 's') {
    ctx.beginPath();
    ctx.moveTo(slx, sly - topElev);
    ctx.lineTo(sbx, sby - topElev);
    ctx.lineTo(sbx, sby - topElev - backH);
    ctx.lineTo(slx, sly - topElev - backH);
    ctx.closePath();
  } else if (rotation === 'e') {
    ctx.beginPath();
    ctx.moveTo(srx, sry - topElev);
    ctx.lineTo(sbx, sby - topElev);
    ctx.lineTo(sbx, sby - topElev - backH);
    ctx.lineTo(srx, sry - topElev - backH);
    ctx.closePath();
  } else {
    ctx.beginPath();
    ctx.moveTo(stx, sty - topElev);
    ctx.lineTo(slx, sly - topElev);
    ctx.lineTo(slx, sly - topElev - backH);
    ctx.lineTo(stx, sty - topElev - backH);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
}

function drawSofa(ctx: SKRSContext2D, ox: number, oy: number, seats: 2 | 3): void {
  const baseH = 14;
  const backH = 20;
  const color = '#6b7280';
  const shade = '#4b5563';
  const dark = '#374151';

  drawIsoBox(ctx, ox, oy, baseH, color, shade, dark);

  // Backrest
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  ctx.beginPath();
  ctx.moveTo(tx, ty - baseH);
  ctx.lineTo(rx, ry - baseH);
  ctx.lineTo(rx, ry - baseH - backH);
  ctx.lineTo(tx, ty - baseH - backH);
  ctx.closePath();
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Seat dividers
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  const dividerCount = seats - 1;
  for (let i = 1; i <= dividerCount; i++) {
    const t = i / seats;
    const dx = tx + (rx - tx) * t;
    const dy = ty + (ry - ty) * t;
    ctx.beginPath();
    ctx.moveTo(dx, dy - baseH);
    ctx.lineTo(dx, dy - baseH - backH);
    ctx.stroke();
  }

  // Armrests
  ctx.fillStyle = dark;
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  ctx.fillRect(lx - 4, ly - baseH - backH / 2, 8, backH / 2);
  ctx.fillRect(rx - 4, ry - baseH - backH / 2, 8, backH / 2);
}

function drawWaterCooler(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Base
  drawIsoBox(ctx, ox, oy, 8, '#e0e0e0', '#bdbdbd', '#9e9e9e');
  // Body (tall cylinder-like)
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(tx - 10, ty - 44, 20, 36);
  ctx.strokeStyle = '#9e9e9e';
  ctx.lineWidth = 1;
  ctx.strokeRect(tx - 10, ty - 44, 20, 36);
  // Water bottle (blue top)
  ctx.fillStyle = '#29b6f6';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 42, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(tx - 5, ty - 52, 10, 12);
  ctx.fillStyle = '#0288d1';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 52, 5, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tap
  ctx.fillStyle = '#42a5f5';
  ctx.fillRect(tx - 3, ty - 16, 6, 4);
}

function drawCoffeeMachine(ctx: SKRSContext2D, ox: number, oy: number): void {
  drawIsoBox(ctx, ox, oy, 8, '#e0e0e0', '#bdbdbd', '#9e9e9e');
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  // Machine body
  ctx.fillStyle = '#212121';
  ctx.fillRect(tx - 14, ty - 38, 28, 30);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(tx - 14, ty - 38, 28, 30);
  // Display panel
  ctx.fillStyle = '#1a237e';
  ctx.fillRect(tx - 8, ty - 35, 16, 8);
  ctx.fillStyle = '#42a5f5';
  ctx.fillRect(tx - 6, ty - 33, 12, 4);
  // Cup area
  ctx.fillStyle = '#333';
  ctx.fillRect(tx - 10, ty - 18, 20, 10);
  // Cup
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(tx - 4, ty - 16, 8, 8);
  // Steam
  ctx.strokeStyle = 'rgba(200,200,200,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tx - 2, ty - 16);
  ctx.quadraticCurveTo(tx - 4, ty - 22, tx - 2, ty - 28);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tx + 2, ty - 16);
  ctx.quadraticCurveTo(tx + 4, ty - 22, tx + 2, ty - 28);
  ctx.stroke();
}

function drawPlantSmall(ctx: SKRSContext2D, ox: number, oy: number): void {
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  // Pot
  drawIsoBox(ctx, ox, oy, 8, '#c17f24', '#a06018', '#885010');
  // Plant
  ctx.fillStyle = '#2e7d32';
  ctx.beginPath();
  ctx.arc(tx, ty - 20, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#388e3c';
  ctx.beginPath();
  ctx.arc(tx - 6, ty - 24, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(tx + 6, ty - 24, 8, 0, Math.PI * 2);
  ctx.fill();
  // Stem
  ctx.strokeStyle = '#1b5e20';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tx, ty - 8);
  ctx.lineTo(tx, ty - 16);
  ctx.stroke();
}

function drawPlantLarge(ctx: SKRSContext2D, ox: number, oy: number): void {
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  // Large pot
  drawIsoBox(ctx, ox, oy, 10, '#8d6e63', '#795548', '#6d4c41');
  // Trunk
  ctx.strokeStyle = '#5d4037';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(tx, ty - 10);
  ctx.lineTo(tx, ty - 36);
  ctx.stroke();
  // Leaves
  ctx.fillStyle = '#1b5e20';
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const lx2 = tx + Math.cos(angle) * 16;
    const ly2 = ty - 36 + Math.sin(angle) * 8;
    ctx.beginPath();
    ctx.ellipse(lx2, ly2, 10, 5, angle, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#2e7d32';
  ctx.beginPath();
  ctx.arc(tx, ty - 42, 14, 0, Math.PI * 2);
  ctx.fill();
}

function drawWhiteboard(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Base (wall mount)
  drawIsoBox(ctx, ox, oy, 4, '#f5f5f5', '#e0e0e0', '#bdbdbd');
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const wbH = 36;
  // Board surface
  ctx.fillStyle = '#fafafa';
  ctx.beginPath();
  ctx.moveTo(tx, ty - 4);
  ctx.lineTo(rx, ry - 4);
  ctx.lineTo(rx, ry - 4 - wbH);
  ctx.lineTo(tx, ty - 4 - wbH);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#9e9e9e';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Some content on whiteboard
  ctx.strokeStyle = '#1565c0';
  ctx.lineWidth = 1;
  const midX = (tx + rx) / 2;
  const midY = (ty + ry) / 2 - 4 - wbH / 2;
  ctx.beginPath();
  ctx.moveTo(tx + 6, midY - 8);
  ctx.lineTo(midX - 4, midY - 8);
  ctx.moveTo(tx + 6, midY);
  ctx.lineTo(midX - 2, midY);
  ctx.moveTo(tx + 6, midY + 8);
  ctx.lineTo(midX - 6, midY + 8);
  ctx.stroke();
  // Marker tray
  ctx.fillStyle = '#e0e0e0';
  ctx.fillRect(tx + 2, ty - 6, rx - tx - 4, 3);
}

function drawBookshelf(ctx: SKRSContext2D, ox: number, oy: number): void {
  drawIsoBox(ctx, ox, oy, 40, '#8d6e63', '#795548', '#6d4c41');
  // Shelves
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const shelfColors = ['#1565c0', '#c62828', '#2e7d32', '#f57f17', '#6a1b9a'];
  for (let shelf = 0; shelf < 3; shelf++) {
    const sy = ty - 12 - shelf * 12;
    ctx.fillStyle = '#a1887f';
    ctx.beginPath();
    ctx.moveTo(tx, sy);
    ctx.lineTo(rx, ry + (sy - ty));
    ctx.lineTo(rx, ry + (sy - ty) + 3);
    ctx.lineTo(tx, sy + 3);
    ctx.closePath();
    ctx.fill();
    // Books on this shelf
    for (let book = 0; book < 4; book++) {
      const t = (book + 0.5) / 4;
      const bx = tx + (rx - tx) * t;
      const by = ty + (ry - ty) * t + (sy - ty) - 8;
      ctx.fillStyle = shelfColors[(shelf * 4 + book) % shelfColors.length] ?? '#555';
      ctx.fillRect(bx - 4, by, 7, 8);
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bx - 4, by, 7, 8);
    }
  }
}

function drawLampDesk(ctx: SKRSContext2D, ox: number, oy: number): void {
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  // Base
  drawIsoBox(ctx, ox, oy, 4, '#bdbdbd', '#9e9e9e', '#757575');
  // Pole
  ctx.strokeStyle = '#616161';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tx, ty - 4);
  ctx.lineTo(tx + 8, ty - 28);
  ctx.stroke();
  // Lampshade
  ctx.fillStyle = '#fff59d';
  ctx.beginPath();
  ctx.moveTo(tx + 4, ty - 28);
  ctx.lineTo(tx + 18, ty - 24);
  ctx.lineTo(tx + 14, ty - 34);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#f9a825';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Light glow
  ctx.fillStyle = 'rgba(255,245,157,0.3)';
  ctx.beginPath();
  ctx.arc(tx + 11, ty - 26, 10, 0, Math.PI * 2);
  ctx.fill();
}

function drawLampFloor(ctx: SKRSContext2D, ox: number, oy: number): void {
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  // Weighted base
  drawIsoBox(ctx, ox, oy, 4, '#757575', '#616161', '#424242');
  // Pole
  ctx.strokeStyle = '#616161';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(tx, ty - 4);
  ctx.lineTo(tx, ty - 48);
  ctx.stroke();
  // Shade
  ctx.fillStyle = '#e0e0e0';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 52, 14, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f5f5f5';
  ctx.beginPath();
  ctx.moveTo(tx - 14, ty - 52);
  ctx.lineTo(tx - 10, ty - 48);
  ctx.lineTo(tx + 10, ty - 48);
  ctx.lineTo(tx + 14, ty - 52);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#9e9e9e';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Glow
  ctx.fillStyle = 'rgba(255,245,200,0.25)';
  ctx.beginPath();
  ctx.arc(tx, ty - 48, 16, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// New tile drawing functions (rooms + furniture)
// ---------------------------------------------------------------------------

function drawFridge(ctx: SKRSContext2D, ox: number, oy: number): void {
  drawIsoBox(ctx, ox, oy, 36, '#f5f5f5', '#e0e0e0', '#bdbdbd');
  // Handle
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const hx = (rx + bx) / 2;
  const hy = (ry + by) / 2 - 18;
  ctx.fillStyle = '#9e9e9e';
  ctx.fillRect(hx - 1, hy - 10, 3, 16);
  // Shelf line
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  ctx.strokeStyle = '#bdbdbd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lx, ly - 18);
  ctx.lineTo(bx, by - 18);
  ctx.stroke();
}

function drawMicrowave(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Counter base
  drawIsoBox(ctx, ox, oy, 8, '#d4a96a', '#b8915a', '#a07848');
  // Microwave body on counter
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  ctx.fillStyle = '#333';
  ctx.fillRect(tx - 18, ty - 22, 36, 14);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(tx - 18, ty - 22, 36, 14);
  // Glass door
  ctx.fillStyle = '#1a237e';
  ctx.fillRect(tx - 14, ty - 20, 20, 10);
  ctx.fillStyle = '#42a5f5';
  ctx.fillRect(tx - 12, ty - 18, 16, 6);
  // Controls
  ctx.fillStyle = '#616161';
  ctx.fillRect(tx + 10, ty - 20, 6, 10);
  ctx.fillStyle = '#4caf50';
  ctx.beginPath();
  ctx.arc(tx + 13, ty - 14, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawSink(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Counter
  drawIsoBox(ctx, ox, oy, 16, '#e0e0e0', '#bdbdbd', '#9e9e9e');
  // Basin
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  ctx.fillStyle = '#b0bec5';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 16, 16, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#78909c';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Faucet
  ctx.strokeStyle = '#9e9e9e';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(tx, ty - 16);
  ctx.lineTo(tx, ty - 30);
  ctx.quadraticCurveTo(tx + 8, ty - 32, tx + 8, ty - 26);
  ctx.stroke();
  // Water drop
  ctx.fillStyle = '#42a5f5';
  ctx.beginPath();
  ctx.arc(tx + 8, ty - 22, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawKitchenTable(ctx: SKRSContext2D, ox: number, oy: number): void {
  drawIsoBox(ctx, ox, oy, 14, '#d4a96a', '#b8915a', '#a07848');
  // Plates
  const [tx, ty] = isoPoint(ox, oy, 0.35, 0.4);
  ctx.fillStyle = '#f5f5f5';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 14, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#bdbdbd';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  const [tx2, ty2] = isoPoint(ox, oy, 0.65, 0.6);
  ctx.fillStyle = '#f5f5f5';
  ctx.beginPath();
  ctx.ellipse(tx2, ty2 - 14, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawToilet(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Base/bowl
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  drawIsoBox(ctx, ox, oy, 12, '#f5f5f5', '#e0e0e0', '#bdbdbd');
  // Seat (oval on top)
  ctx.fillStyle = '#fafafa';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 12, 18, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#bdbdbd';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Inner hole
  ctx.fillStyle = '#e3f2fd';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 12, 12, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tank
  const [ttx] = isoPoint(ox, oy, 0.5, 0.1);
  ctx.fillStyle = '#e0e0e0';
  ctx.fillRect(ttx - 14, ty - 30, 28, 14);
  ctx.strokeStyle = '#bdbdbd';
  ctx.strokeRect(ttx - 14, ty - 30, 28, 14);
  // Flush button
  ctx.fillStyle = '#9e9e9e';
  ctx.beginPath();
  ctx.arc(ttx, ty - 32, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawBathroomSink(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Pedestal
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  drawIsoBox(ctx, ox, oy, 14, '#f5f5f5', '#e0e0e0', '#bdbdbd');
  // Basin
  ctx.fillStyle = '#e3f2fd';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 14, 14, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#90caf9';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Faucet
  ctx.strokeStyle = '#bdbdbd';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tx, ty - 14);
  ctx.lineTo(tx, ty - 24);
  ctx.quadraticCurveTo(tx + 6, ty - 26, tx + 6, ty - 20);
  ctx.stroke();
}

function drawPouf(ctx: SKRSContext2D, ox: number, oy: number): void {
  const [tx, ty] = isoPoint(ox, oy, 0.5, 0.5);
  // Rounded base
  drawIsoBox(ctx, ox, oy, 10, '#e8b84b', '#d4a43a', '#c09030');
  // Soft top cushion (elliptical)
  ctx.fillStyle = '#f0c060';
  ctx.beginPath();
  ctx.ellipse(tx, ty - 10, 20, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#c09030';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Button
  ctx.fillStyle = '#d4a43a';
  ctx.beginPath();
  ctx.arc(tx, ty - 12, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawHrDesk(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Reuse desk drawing
  drawIsoBox(ctx, ox, oy, 16, '#b8916a', '#9a7858', '#826448');
  // Monitor
  const [t1x, t1y] = isoPoint(ox, oy, 0.5, 0.3);
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(t1x - 12, t1y - 28, 22, 16);
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(t1x - 10, t1y - 26, 18, 12);
  ctx.fillStyle = '#555';
  ctx.fillRect(t1x - 2, t1y - 12, 4, 5);
  ctx.fillRect(t1x - 5, t1y - 7, 10, 2);
  // Nameplate (HR)
  ctx.fillStyle = '#c9a227';
  const [nx, ny] = isoPoint(ox, oy, 0.5, 0.85);
  ctx.fillRect(nx - 14, ny - 12, 26, 6);
  ctx.fillStyle = '#4a3d1e';
  ctx.font = '6px Arial';
  ctx.fillText('HR', nx - 4, ny - 7);
  // File organizer
  const [fx, fy] = isoPoint(ox, oy, 0.15, 0.6);
  ctx.fillStyle = '#795548';
  ctx.fillRect(fx - 6, fy - 22, 12, 16);
  ctx.strokeStyle = '#5d4037';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(fx - 6, fy - 22, 12, 16);
  // Files
  ctx.fillStyle = '#fff';
  ctx.fillRect(fx - 4, fy - 20, 8, 3);
  ctx.fillRect(fx - 4, fy - 15, 8, 3);
  ctx.fillRect(fx - 4, fy - 10, 8, 3);
}

function drawDoor(ctx: SKRSContext2D, ox: number, oy: number): void {
  // Floor tile base
  drawIsoDiamond(ctx, ox, oy, '#d4c9b0', '#a89880');
  // Door mat / threshold indicator
  const [tx, ty] = isoPoint(ox, oy, 0, 0);
  const [rx, ry] = isoPoint(ox, oy, 1, 0);
  const [bx, by] = isoPoint(ox, oy, 1, 1);
  const [lx, ly] = isoPoint(ox, oy, 0, 1);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(rx, ry);
  ctx.lineTo(bx, by);
  ctx.lineTo(lx, ly);
  ctx.closePath();
  ctx.clip();
  // Darker strip to indicate doorway
  ctx.fillStyle = 'rgba(139, 115, 85, 0.4)';
  const midTLx = (tx + lx) / 2;
  const midTLy = (ty + ly) / 2;
  const midTRx = (rx + bx) / 2;
  const midTRy = (ry + by) / 2;
  ctx.beginPath();
  ctx.moveTo(midTLx, midTLy);
  ctx.lineTo(tx, ty);
  ctx.lineTo(rx, ry);
  ctx.lineTo(midTRx, midTRy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawInternalWallLeft(ctx: SKRSContext2D, ox: number, oy: number): void {
  const wallH = 28;
  drawIsoDiamond(ctx, ox, oy, '#d4c9b0', '#a89880');
  drawIsoLeftWall(ctx, ox, oy, wallH, '#c2b9a6', '#9a8e80');
  drawIsoRightWall(ctx, ox, oy, wallH, '#d0c7b4', '#a89880');
}

function drawInternalWallRight(ctx: SKRSContext2D, ox: number, oy: number): void {
  const wallH = 28;
  drawIsoDiamond(ctx, ox, oy, '#d4c9b0', '#a89880');
  drawIsoRightWall(ctx, ox, oy, wallH, '#c2b9a6', '#9a8e80');
}

// ---------------------------------------------------------------------------
// Build tile definitions list
// ---------------------------------------------------------------------------

function buildTileList(): TileDef[] {
  return [
    { name: 'floor_wood',      draw: (ctx, ox, oy) => drawFloorWood(ctx, ox, oy) },
    { name: 'floor_carpet',    draw: (ctx, ox, oy) => drawFloorCarpet(ctx, ox, oy) },
    { name: 'floor_tile',      draw: (ctx, ox, oy) => drawFloorTile(ctx, ox, oy) },
    { name: 'wall_left',        draw: (ctx, ox, oy) => drawWallLeft(ctx, ox, oy) },
    { name: 'wall_left_solid',  draw: (ctx, ox, oy) => drawWallLeft(ctx, ox, oy, false) },
    { name: 'wall_right',       draw: (ctx, ox, oy) => drawWallRight(ctx, ox, oy) },
    { name: 'wall_right_solid', draw: (ctx, ox, oy) => drawWallRight(ctx, ox, oy, false) },
    { name: 'wall_corner',      draw: (ctx, ox, oy) => drawWallCorner(ctx, ox, oy) },
    { name: 'desk_standard',   draw: (ctx, ox, oy) => drawDeskStandard(ctx, ox, oy) },
    { name: 'desk_standing',   draw: (ctx, ox, oy) => drawDeskStanding(ctx, ox, oy) },
    { name: 'desk_lead',       draw: (ctx, ox, oy) => drawDeskLead(ctx, ox, oy) },
    { name: 'chair_n',         draw: (ctx, ox, oy) => drawChair(ctx, ox, oy, 'n') },
    { name: 'chair_s',         draw: (ctx, ox, oy) => drawChair(ctx, ox, oy, 's') },
    { name: 'chair_e',         draw: (ctx, ox, oy) => drawChair(ctx, ox, oy, 'e') },
    { name: 'chair_w',         draw: (ctx, ox, oy) => drawChair(ctx, ox, oy, 'w') },
    { name: 'sofa_2seat',      draw: (ctx, ox, oy) => drawSofa(ctx, ox, oy, 2) },
    { name: 'sofa_3seat',      draw: (ctx, ox, oy) => drawSofa(ctx, ox, oy, 3) },
    { name: 'water_cooler',    draw: (ctx, ox, oy) => drawWaterCooler(ctx, ox, oy) },
    { name: 'coffee_machine',  draw: (ctx, ox, oy) => drawCoffeeMachine(ctx, ox, oy) },
    { name: 'plant_small',     draw: (ctx, ox, oy) => drawPlantSmall(ctx, ox, oy) },
    { name: 'plant_large',     draw: (ctx, ox, oy) => drawPlantLarge(ctx, ox, oy) },
    { name: 'whiteboard',      draw: (ctx, ox, oy) => drawWhiteboard(ctx, ox, oy) },
    { name: 'bookshelf',       draw: (ctx, ox, oy) => drawBookshelf(ctx, ox, oy) },
    { name: 'lamp_desk',       draw: (ctx, ox, oy) => drawLampDesk(ctx, ox, oy) },
    { name: 'lamp_floor',      draw: (ctx, ox, oy) => drawLampFloor(ctx, ox, oy) },
    { name: 'fridge',          draw: (ctx, ox, oy) => drawFridge(ctx, ox, oy) },
    { name: 'microwave',       draw: (ctx, ox, oy) => drawMicrowave(ctx, ox, oy) },
    { name: 'sink',            draw: (ctx, ox, oy) => drawSink(ctx, ox, oy) },
    { name: 'kitchen_table',   draw: (ctx, ox, oy) => drawKitchenTable(ctx, ox, oy) },
    { name: 'toilet',          draw: (ctx, ox, oy) => drawToilet(ctx, ox, oy) },
    { name: 'bathroom_sink',   draw: (ctx, ox, oy) => drawBathroomSink(ctx, ox, oy) },
    { name: 'pouf',            draw: (ctx, ox, oy) => drawPouf(ctx, ox, oy) },
    { name: 'hr_desk',         draw: (ctx, ox, oy) => drawHrDesk(ctx, ox, oy) },
    { name: 'door',            draw: (ctx, ox, oy) => drawDoor(ctx, ox, oy) },
    { name: 'internal_wall_left',  draw: (ctx, ox, oy) => drawInternalWallLeft(ctx, ox, oy) },
    { name: 'internal_wall_right', draw: (ctx, ox, oy) => drawInternalWallRight(ctx, ox, oy) },
  ];
}

// ---------------------------------------------------------------------------
// Atlas builder
// ---------------------------------------------------------------------------

interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

interface AtlasData {
  frames: Record<string, AtlasFrame>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
  };
}

function buildTileAtlas(tiles: TileDef[], sheetW: number, sheetH: number): AtlasData {
  const frames: Record<string, AtlasFrame> = {};

  tiles.forEach((tile, index) => {
    const col = index % TILES_PER_ROW;
    const row = Math.floor(index / TILES_PER_ROW);
    frames[tile.name] = {
      frame: { x: col * TILE_W, y: row * CELL_H, w: TILE_W, h: CELL_H },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: TILE_W, h: CELL_H },
      sourceSize: { w: TILE_W, h: CELL_H },
    };
  });

  return {
    frames,
    meta: {
      app: 'ai-office-tile-generator',
      version: '1.0.0',
      image: 'office-tileset.png',
      format: 'RGBA8888',
      size: { w: sheetW, h: sheetH },
      scale: '1',
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Office Tileset Generator ===');

  const tiles = buildTileList();
  console.log(`Generating ${tiles.length} tiles...`);

  const rows = Math.ceil(tiles.length / TILES_PER_ROW);
  const sheetW = TILES_PER_ROW * TILE_W;
  const sheetH = rows * CELL_H;

  console.log(`Sheet size: ${sheetW}x${sheetH}, ${TILES_PER_ROW} tiles per row`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const canvas: Canvas = createCanvas(sheetW, sheetH);
  const ctx = canvas.getContext('2d') as SKRSContext2D;
  ctx.clearRect(0, 0, sheetW, sheetH);

  tiles.forEach((tile, index) => {
    const col = index % TILES_PER_ROW;
    const row = Math.floor(index / TILES_PER_ROW);
    const ox = col * TILE_W;
    const oy = row * CELL_H;

    // Save state and clip to tile cell bounds (128x128 to allow tall objects)
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, TILE_W, CELL_H);
    ctx.clip();

    // Offset drawing so the iso diamond sits at the bottom of the cell
    tile.draw(ctx, ox, oy + (CELL_H - TILE_H));
    ctx.restore();
    console.log(`  Drew: ${tile.name} (col=${col}, row=${row})`);
  });

  // Write PNG
  const pngPath = path.join(OUTPUT_DIR, 'office-tileset.png');
  const pngBuffer = canvas.toBuffer('image/png');
  fs.writeFileSync(pngPath, pngBuffer);
  console.log(`Wrote ${pngPath} (${Math.round(pngBuffer.length / 1024)}KB)`);

  // Write JSON
  const atlas = buildTileAtlas(tiles, sheetW, sheetH);
  const jsonPath = path.join(OUTPUT_DIR, 'office-tileset.json');
  fs.writeFileSync(jsonPath, JSON.stringify(atlas, null, 2));
  console.log(`Wrote ${jsonPath}`);

  console.log('Done! Office tileset generated.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
