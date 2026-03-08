/**
 * Agent Spritesheet Generator
 *
 * Generates 4 agent spritesheet PNGs with PixiJS-compatible JSON atlas files.
 * Uses @napi-rs/canvas for Node.js Canvas 2D API.
 *
 * Output per tier: src/assets/sprites/agents/{tier}.png + {tier}.json
 * Frame size: 64x64 pixels
 * Total frames per tier: 56
 */

import { createCanvas, Canvas, SKRSContext2D } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TierStyle {
  bodyColor: string;
  accentColor: string;
  skinColor: string;
  badgeColor: string | null;
  hasBadge: boolean;
  hasTie: boolean;
  hasHoodie: boolean;
  outlineColor: string;
  hairColor: string;
  clothingStyle: 'suit' | 'shirt' | 'hoodie' | 'tshirt';
}

interface AnimationDef {
  name: string;
  frames: number;
  speedMs: number;
}

interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  duration: number;
}

interface AtlasData {
  frames: Record<string, AtlasFrame>;
  animations: Record<string, string[]>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRAME_W = 64;
const FRAME_H = 64;
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, 'src/assets/sprites/agents');

const ANIMATIONS: AnimationDef[] = [
  { name: 'idle_stand',   frames: 4,  speedMs: 200 },
  { name: 'idle_sit',     frames: 4,  speedMs: 300 },
  { name: 'walk_down',    frames: 6,  speedMs: 100 },
  { name: 'walk_up',      frames: 6,  speedMs: 100 },
  { name: 'walk_side',    frames: 6,  speedMs: 100 },
  { name: 'typing',       frames: 4,  speedMs: 150 },
  { name: 'thinking',     frames: 6,  speedMs: 250 },
  { name: 'celebrating',  frames: 4,  speedMs: 200 },
  { name: 'frustrated',   frames: 4,  speedMs: 200 },
  { name: 'drinking',     frames: 4,  speedMs: 300 },
  { name: 'coffee',       frames: 4,  speedMs: 300 },
  { name: 'phone',        frames: 4,  speedMs: 400 },
];

// Total frames = 4+4+6+6+6+4+6+4+4+4+4+4 = 56
const TOTAL_FRAMES = ANIMATIONS.reduce((sum, a) => sum + a.frames, 0);

// Spritesheet layout: 16 frames per row (1024px wide), rows as needed
const FRAMES_PER_ROW = 16;
const SHEET_W = FRAMES_PER_ROW * FRAME_W; // 1024
const SHEET_ROWS = Math.ceil(TOTAL_FRAMES / FRAMES_PER_ROW);
const SHEET_H = SHEET_ROWS * FRAME_H; // 256 (4 rows for 56 frames)

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

const TIERS: Record<string, TierStyle> = {
  expert: {
    bodyColor: '#1a2744',
    accentColor: '#c9a227',
    skinColor: '#f4c2a1',
    badgeColor: '#c9a227',
    hasBadge: true,
    hasTie: true,
    hasHoodie: false,
    outlineColor: '#0d1b2a',
    hairColor: '#2c2c2c',
    clothingStyle: 'suit',
  },
  senior: {
    bodyColor: '#2456a4',
    accentColor: '#1a3a6e',
    skinColor: '#f4c2a1',
    badgeColor: '#4a90d9',
    hasBadge: true,
    hasTie: false,
    hasHoodie: false,
    outlineColor: '#0d2244',
    hairColor: '#4a3728',
    clothingStyle: 'shirt',
  },
  middle: {
    bodyColor: '#4a7c59',
    accentColor: '#6b6b6b',
    skinColor: '#ead5b7',
    badgeColor: '#5cb85c',
    hasBadge: true,
    hasTie: false,
    hasHoodie: true,
    outlineColor: '#2d4a35',
    hairColor: '#8b6914',
    clothingStyle: 'hoodie',
  },
  junior: {
    bodyColor: '#e07b39',
    accentColor: '#cccccc',
    skinColor: '#fde4c8',
    badgeColor: null,
    hasBadge: false,
    hasTie: false,
    hasHoodie: false,
    outlineColor: '#8b4513',
    hairColor: '#d4a017',
    clothingStyle: 'tshirt',
  },
};

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/** Draw a rounded rectangle path */
function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Draw ellipse helper */
function drawEllipse(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number
): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Character drawing functions
// ---------------------------------------------------------------------------

/** Draw the character head */
function drawHead(
  ctx: SKRSContext2D,
  style: TierStyle,
  cx: number,
  cy: number,
  tiltX: number = 0,
  tiltY: number = 0
): void {
  // Head shadow
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  drawEllipse(ctx, cx + 1, cy + tiltY + 14, 11, 4);
  ctx.fill();

  // Neck
  ctx.fillStyle = style.skinColor;
  ctx.fillRect(cx - 3, cy + tiltY + 8, 6, 6);

  // Head base
  ctx.fillStyle = style.skinColor;
  ctx.strokeStyle = style.outlineColor;
  ctx.lineWidth = 1;
  drawEllipse(ctx, cx + tiltX, cy + tiltY, 11, 12);
  ctx.fill();
  ctx.stroke();

  // Hair
  ctx.fillStyle = style.hairColor;
  ctx.beginPath();
  ctx.ellipse(cx + tiltX, cy + tiltY - 4, 11, 8, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fill();

  // Eyes
  ctx.fillStyle = '#fff';
  drawEllipse(ctx, cx + tiltX - 3.5, cy + tiltY, 2.5, 2);
  ctx.fill();
  drawEllipse(ctx, cx + tiltX + 3.5, cy + tiltY, 2.5, 2);
  ctx.fill();

  // Pupils
  ctx.fillStyle = '#333';
  drawEllipse(ctx, cx + tiltX - 3, cy + tiltY, 1.2, 1.2);
  ctx.fill();
  drawEllipse(ctx, cx + tiltX + 4, cy + tiltY, 1.2, 1.2);
  ctx.fill();

  // Mouth (small smile)
  ctx.strokeStyle = style.outlineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx + tiltX, cy + tiltY + 5, 3, 0.2, Math.PI - 0.2);
  ctx.stroke();
}

/** Draw character body */
function drawBody(
  ctx: SKRSContext2D,
  style: TierStyle,
  cx: number,
  cy: number,
  frame: number = 0,
  animName: string = 'idle_stand'
): void {
  const bodyY = cy;

  // Body shadow
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  drawEllipse(ctx, cx + 1, bodyY + 22, 14, 4);
  ctx.fill();

  // Torso
  ctx.fillStyle = style.bodyColor;
  ctx.strokeStyle = style.outlineColor;
  ctx.lineWidth = 1.2;
  roundRect(ctx, cx - 11, bodyY, 22, 20, 4);
  ctx.fill();
  ctx.stroke();

  // Clothing details
  if (style.clothingStyle === 'suit') {
    // Jacket lapels
    ctx.fillStyle = style.accentColor;
    ctx.beginPath();
    ctx.moveTo(cx - 4, bodyY);
    ctx.lineTo(cx, bodyY + 6);
    ctx.lineTo(cx + 4, bodyY);
    ctx.closePath();
    ctx.fill();

    // Tie
    ctx.fillStyle = style.accentColor;
    ctx.beginPath();
    ctx.moveTo(cx - 2, bodyY + 2);
    ctx.lineTo(cx + 2, bodyY + 2);
    ctx.lineTo(cx + 1.5, bodyY + 14);
    ctx.lineTo(cx, bodyY + 16);
    ctx.lineTo(cx - 1.5, bodyY + 14);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = style.outlineColor;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  } else if (style.clothingStyle === 'shirt') {
    // Collar
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(cx - 5, bodyY);
    ctx.lineTo(cx, bodyY + 5);
    ctx.lineTo(cx + 5, bodyY);
    ctx.closePath();
    ctx.fill();
    // Buttons
    ctx.fillStyle = style.accentColor;
    for (let i = 0; i < 3; i++) {
      drawEllipse(ctx, cx, bodyY + 5 + i * 4.5, 1, 1);
      ctx.fill();
    }
  } else if (style.clothingStyle === 'hoodie') {
    // Hoodie pocket
    ctx.fillStyle = style.accentColor;
    roundRect(ctx, cx - 6, bodyY + 12, 12, 6, 2);
    ctx.fill();
    // Hood drawstrings
    ctx.strokeStyle = style.accentColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 2, bodyY + 2);
    ctx.lineTo(cx - 4, bodyY + 8);
    ctx.moveTo(cx + 2, bodyY + 2);
    ctx.lineTo(cx + 4, bodyY + 8);
    ctx.stroke();
  } else {
    // T-shirt: no extra details, but add a subtle center line
    ctx.strokeStyle = style.accentColor;
    ctx.lineWidth = 0.8;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(cx, bodyY + 2);
    ctx.lineTo(cx, bodyY + 18);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Badge (if applicable)
  if (style.hasBadge && style.badgeColor) {
    ctx.fillStyle = style.badgeColor;
    drawEllipse(ctx, cx + 7, bodyY + 4, 3, 3);
    ctx.fill();
    ctx.strokeStyle = style.outlineColor;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    // Star on badge
    ctx.fillStyle = '#fff';
    ctx.font = '4px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', cx + 7, bodyY + 4);
  }
}

/** Draw legs */
function drawLegs(
  ctx: SKRSContext2D,
  style: TierStyle,
  cx: number,
  cy: number,
  frame: number = 0,
  animName: string = 'idle_stand'
): void {
  const legColor = style.clothingStyle === 'suit' ? '#0d1b2a' : '#555';
  const shoeColor = '#222';

  // Walking animation offsets
  let leftLegOffset = 0;
  let rightLegOffset = 0;

  if (animName.startsWith('walk')) {
    const cycle = frame % 4;
    const offsets = [0, 4, 0, -4];
    leftLegOffset = offsets[cycle] ?? 0;
    rightLegOffset = -(offsets[cycle] ?? 0);
  }

  // Left leg
  ctx.fillStyle = legColor;
  ctx.strokeStyle = style.outlineColor;
  ctx.lineWidth = 1;
  roundRect(ctx, cx - 9, cy + leftLegOffset, 7, 14, 2);
  ctx.fill();
  ctx.stroke();

  // Right leg
  roundRect(ctx, cx + 2, cy + rightLegOffset, 7, 14, 2);
  ctx.fill();
  ctx.stroke();

  // Shoes
  ctx.fillStyle = shoeColor;
  roundRect(ctx, cx - 11, cy + 12 + leftLegOffset, 9, 4, 2);
  ctx.fill();
  roundRect(ctx, cx + 2, cy + 12 + rightLegOffset, 9, 4, 2);
  ctx.fill();
}

/** Draw arms */
function drawArms(
  ctx: SKRSContext2D,
  style: TierStyle,
  cx: number,
  cy: number,
  frame: number = 0,
  animName: string = 'idle_stand'
): void {
  const armColor = style.bodyColor;
  let leftArmAngle = 0;
  let rightArmAngle = 0;
  let leftArmY = 0;
  let rightArmY = 0;

  // Adjust arm positions based on animation
  if (animName === 'celebrating') {
    // Arms raised up
    leftArmY = -8 - (frame % 2) * 2;
    rightArmY = -8 - (frame % 2) * 2;
  } else if (animName === 'frustrated') {
    // Hands to head
    leftArmY = -5;
    rightArmY = -5;
    leftArmAngle = -0.4;
    rightArmAngle = 0.4;
  } else if (animName === 'thinking') {
    // One hand on chin
    rightArmY = -3;
    rightArmAngle = -0.3;
  } else if (animName === 'typing') {
    // Arms forward/down
    leftArmY = 4;
    rightArmY = 4;
  } else if (animName === 'drinking' || animName === 'coffee') {
    // One arm raised holding cup
    rightArmY = -4 + (frame % 2);
    rightArmAngle = -0.5;
  } else if (animName === 'phone') {
    // Arm up holding phone
    rightArmY = -6;
    rightArmAngle = -0.6;
  } else if (animName.startsWith('walk')) {
    // Swing arms while walking
    const cycle = frame % 4;
    const swings = [0, 4, 0, -4];
    leftArmY = swings[cycle] ?? 0;
    rightArmY = -(swings[cycle] ?? 0);
  }

  ctx.fillStyle = armColor;
  ctx.strokeStyle = style.outlineColor;
  ctx.lineWidth = 1;

  // Left arm
  ctx.save();
  ctx.translate(cx - 14, cy + 2 + leftArmY);
  ctx.rotate(leftArmAngle);
  roundRect(ctx, -4, 0, 7, 14, 3);
  ctx.fill();
  ctx.stroke();
  // Left hand
  ctx.fillStyle = style.skinColor;
  drawEllipse(ctx, 0, 14, 3.5, 3);
  ctx.fill();
  ctx.restore();

  // Right arm
  ctx.fillStyle = armColor;
  ctx.strokeStyle = style.outlineColor;
  ctx.save();
  ctx.translate(cx + 14, cy + 2 + rightArmY);
  ctx.rotate(rightArmAngle);
  roundRect(ctx, -3, 0, 7, 14, 3);
  ctx.fill();
  ctx.stroke();
  // Right hand
  ctx.fillStyle = style.skinColor;
  drawEllipse(ctx, 3, 14, 3.5, 3);
  ctx.fill();
  ctx.restore();

  // Props (cup, phone) for specific animations
  if (animName === 'coffee' || animName === 'drinking') {
    ctx.fillStyle = animName === 'coffee' ? '#6f4e37' : '#29b6f6';
    roundRect(ctx, cx + 15, cy - 4 + rightArmY, 6, 9, 1);
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  if (animName === 'phone') {
    ctx.fillStyle = '#1a1a1a';
    roundRect(ctx, cx + 15, cy - 8 + rightArmY, 5, 9, 1);
    ctx.fill();
    ctx.fillStyle = '#4fc3f7';
    ctx.fillRect(cx + 16, cy - 7 + rightArmY, 3, 6);
  }
}

/** Draw a complete standing character */
function drawCharacterStanding(
  ctx: SKRSContext2D,
  style: TierStyle,
  frame: number,
  animName: string,
  offsetX: number,
  offsetY: number
): void {
  const cx = offsetX + FRAME_W / 2;
  const cy = offsetY;

  // Breathing animation — subtle vertical shift for idle
  let breathOffset = 0;
  if (animName === 'idle_stand') {
    breathOffset = frame % 2 === 0 ? 0 : -1;
  }

  const baseY = cy + 6 + breathOffset;

  // Draw in correct Z-order: legs -> body -> arms -> head
  drawLegs(ctx, style, cx, baseY + 22, frame, animName);
  drawBody(ctx, style, cx, baseY + 6, frame, animName);
  drawArms(ctx, style, cx, baseY + 6, frame, animName);
  drawHead(ctx, style, cx, baseY, frame % 2 === 0 ? 0 : 0, 0);
}

/** Draw a sitting character */
function drawCharacterSitting(
  ctx: SKRSContext2D,
  style: TierStyle,
  frame: number,
  animName: string,
  offsetX: number,
  offsetY: number
): void {
  const cx = offsetX + FRAME_W / 2;
  const cy = offsetY + 4;

  // No breathing for sitting work animations — agent stays still at desk
  const torsoY = cy + 10;

  // Draw legs (bent/sitting)
  ctx.fillStyle = style.clothingStyle === 'suit' ? '#0d1b2a' : '#555';
  ctx.strokeStyle = style.outlineColor;
  ctx.lineWidth = 1;
  // Left leg (horizontal)
  roundRect(ctx, cx - 16, torsoY + 20, 14, 7, 2);
  ctx.fill();
  ctx.stroke();
  // Right leg
  roundRect(ctx, cx + 2, torsoY + 20, 14, 7, 2);
  ctx.fill();
  ctx.stroke();
  // Shoes
  ctx.fillStyle = '#222';
  roundRect(ctx, cx - 16, torsoY + 25, 6, 5, 2);
  ctx.fill();
  roundRect(ctx, cx + 10, torsoY + 25, 6, 5, 2);
  ctx.fill();

  // Chair seat indication
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  roundRect(ctx, cx - 16, torsoY + 26, 32, 4, 2);
  ctx.fill();

  drawBody(ctx, style, cx, torsoY, frame, animName);
  drawArms(ctx, style, cx, torsoY, frame, 'typing');
  drawHead(ctx, style, cx, torsoY - 16, 0, 0);
}

// ---------------------------------------------------------------------------
// Frame rendering dispatcher
// ---------------------------------------------------------------------------

function renderFrame(
  ctx: SKRSContext2D,
  style: TierStyle,
  animName: string,
  frame: number,
  frameIndex: number
): void {
  const col = frameIndex % FRAMES_PER_ROW;
  const row = Math.floor(frameIndex / FRAMES_PER_ROW);
  const ox = col * FRAME_W;
  const oy = row * FRAME_H;

  ctx.clearRect(ox, oy, FRAME_W, FRAME_H);

  // Clip to frame bounds
  ctx.save();
  ctx.rect(ox, oy, FRAME_W, FRAME_H);
  ctx.clip();

  const sitAnims = new Set(['idle_sit', 'typing']);
  if (sitAnims.has(animName)) {
    drawCharacterSitting(ctx, style, frame, animName, ox, oy);
  } else {
    drawCharacterStanding(ctx, style, frame, animName, ox, oy);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Atlas builder
// ---------------------------------------------------------------------------

function buildAtlas(tierName: string): AtlasData {
  const frames: Record<string, AtlasFrame> = {};
  const animations: Record<string, string[]> = {};

  let frameIndex = 0;

  for (const anim of ANIMATIONS) {
    const frameKeys: string[] = [];
    for (let f = 0; f < anim.frames; f++) {
      const key = `${anim.name}_${f}`;
      const col = frameIndex % FRAMES_PER_ROW;
      const row = Math.floor(frameIndex / FRAMES_PER_ROW);

      frames[key] = {
        frame: { x: col * FRAME_W, y: row * FRAME_H, w: FRAME_W, h: FRAME_H },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: FRAME_W, h: FRAME_H },
        sourceSize: { w: FRAME_W, h: FRAME_H },
        duration: anim.speedMs,
      };

      frameKeys.push(key);
      frameIndex++;
    }
    animations[anim.name] = frameKeys;
  }

  return {
    frames,
    animations,
    meta: {
      app: 'ai-office-sprite-generator',
      version: '1.0.0',
      image: `${tierName}.png`,
      format: 'RGBA8888',
      size: { w: SHEET_W, h: SHEET_H },
      scale: '1',
    },
  };
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

async function generateTierSpritesheet(tierName: string, style: TierStyle): Promise<void> {
  console.log(`Generating ${tierName} spritesheet (${TOTAL_FRAMES} frames, ${SHEET_W}x${SHEET_H})...`);

  const canvas: Canvas = createCanvas(SHEET_W, SHEET_H);
  const ctx = canvas.getContext('2d') as SKRSContext2D;

  // Fill transparent background
  ctx.clearRect(0, 0, SHEET_W, SHEET_H);

  let frameIndex = 0;

  for (const anim of ANIMATIONS) {
    for (let f = 0; f < anim.frames; f++) {
      renderFrame(ctx, style, anim.name, f, frameIndex);
      frameIndex++;
    }
  }

  // Save PNG
  const pngPath = path.join(OUTPUT_DIR, `${tierName}.png`);
  const pngBuffer = canvas.toBuffer('image/png');
  fs.writeFileSync(pngPath, pngBuffer);
  console.log(`  Wrote ${pngPath} (${Math.round(pngBuffer.length / 1024)}KB)`);

  // Save JSON atlas
  const atlas = buildAtlas(tierName);
  const jsonPath = path.join(OUTPUT_DIR, `${tierName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(atlas, null, 2));
  console.log(`  Wrote ${jsonPath}`);
}

async function main(): Promise<void> {
  console.log('=== Agent Spritesheet Generator ===');
  console.log(`Frame size: ${FRAME_W}x${FRAME_H}, Sheet: ${SHEET_W}x${SHEET_H}`);
  console.log(`Total frames per tier: ${TOTAL_FRAMES}`);
  console.log('');

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const [tierName, style] of Object.entries(TIERS)) {
    await generateTierSpritesheet(tierName, style);
  }

  console.log('');
  console.log('Done! All agent spritesheets generated.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
