/**
 * Effects & Icons SVG Generator
 *
 * Generates all SVG icons, badges and effect assets for OfficeAI.
 * All files are self-contained optimized SVGs with correct viewBox attributes.
 *
 * Outputs:
 *   src/assets/sprites/effects/
 *     speech_bubble.svg
 *     thinking_indicator.svg
 *     status_icons/
 *       checkmark_green.svg
 *       exclamation_red.svg
 *       gear_spinning.svg
 *       terminal_icon.svg
 *       file_icon.svg
 *       browser_icon.svg
 *     badges/
 *       badge_gold.svg
 *       badge_blue.svg
 *       badge_green.svg
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SvgFile {
  relativePath: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFECTS_DIR = path.resolve(PROJECT_ROOT, 'src/assets/sprites/effects');

// ---------------------------------------------------------------------------
// SVG builder helpers
// ---------------------------------------------------------------------------

/** Wrap SVG content in an SVG root element */
function svg(
  viewBox: string,
  width: number,
  height: number,
  content: string,
  extraAttrs: string = ''
): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}"${extraAttrs ? ' ' + extraAttrs : ''}>`,
    content,
    `</svg>`,
  ].join('\n');
}

/** Generate a CSS animation block */
function cssBlock(css: string): string {
  return `<style>${css}</style>`;
}

// ---------------------------------------------------------------------------
// Status icons (24x24 viewBox)
// ---------------------------------------------------------------------------

function makeCheckmarkGreen(): string {
  return svg('0 0 24 24', 24, 24, `
  <circle cx="12" cy="12" r="11" fill="#4caf50" stroke="#2e7d32" stroke-width="1.2"/>
  <polyline points="6,12 10,16 18,8" fill="none" stroke="#fff" stroke-width="2.2"
    stroke-linecap="round" stroke-linejoin="round"/>
`);
}

function makeExclamationRed(): string {
  return svg('0 0 24 24', 24, 24, `
  <circle cx="12" cy="12" r="11" fill="#f44336" stroke="#b71c1c" stroke-width="1.2"/>
  <line x1="12" y1="7" x2="12" y2="14" stroke="#fff" stroke-width="2.2"
    stroke-linecap="round"/>
  <circle cx="12" cy="17.5" r="1.3" fill="#fff"/>
`);
}

function makeGearSpinning(): string {
  return svg('0 0 24 24', 24, 24, `
  ${cssBlock(`
    @keyframes gear-spin {
      from { transform: rotate(0deg); transform-origin: 12px 12px; }
      to   { transform: rotate(360deg); transform-origin: 12px 12px; }
    }
    .gear { animation: gear-spin 2s linear infinite; }
  `)}
  <g class="gear">
    <path fill="#757575" d="
      M12 2
      L13.5 5.2 16.9 4.1 16.9 7.1
      L20 8.5 18.5 11.5 21 14
      L18.5 14.5 17.9 17.9 14.8 18.5
      L12 22 9.2 18.5 6.1 17.9 5.5 14.5
      L3 14 5.5 11.5 4 8.5 7.1 7.1
      L7.1 4.1 10.5 5.2 Z
    "/>
    <!-- Simplified gear using circles and a center hole -->
    <circle cx="12" cy="12" r="9" fill="#9e9e9e" stroke="#616161" stroke-width="1"/>
    <circle cx="12" cy="12" r="4" fill="#424242"/>
    <!-- Teeth approximation via rotated rects -->
    <rect x="11" y="2" width="2" height="3" rx="0.5" fill="#9e9e9e"/>
    <rect x="11" y="19" width="2" height="3" rx="0.5" fill="#9e9e9e"/>
    <rect x="2" y="11" width="3" height="2" rx="0.5" fill="#9e9e9e"/>
    <rect x="19" y="11" width="3" height="2" rx="0.5" fill="#9e9e9e"/>
    <rect x="4.5" y="4.5" width="2" height="3" rx="0.5" fill="#9e9e9e" transform="rotate(45 5.5 6)"/>
    <rect x="17.5" y="4.5" width="2" height="3" rx="0.5" fill="#9e9e9e" transform="rotate(-45 18.5 6)"/>
    <rect x="4.5" y="17.5" width="2" height="3" rx="0.5" fill="#9e9e9e" transform="rotate(-45 5.5 18)"/>
    <rect x="17.5" y="17.5" width="2" height="3" rx="0.5" fill="#9e9e9e" transform="rotate(45 18.5 18)"/>
  </g>
`);
}

function makeTerminalIcon(): string {
  return svg('0 0 24 24', 24, 24, `
  <rect x="1" y="3" width="22" height="18" rx="3" ry="3"
    fill="#212121" stroke="#424242" stroke-width="1"/>
  <!-- Titlebar -->
  <rect x="1" y="3" width="22" height="5" rx="3" ry="3" fill="#333"/>
  <rect x="1" y="5.5" width="22" height="2.5" fill="#333"/>
  <!-- Traffic lights -->
  <circle cx="5" cy="5.5" r="1.2" fill="#ef5350"/>
  <circle cx="8.5" cy="5.5" r="1.2" fill="#ffb300"/>
  <circle cx="12" cy="5.5" r="1.2" fill="#66bb6a"/>
  <!-- Prompt > -->
  <polyline points="4,12 8,15 4,18" fill="none" stroke="#4caf50"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Cursor line -->
  <line x1="10" y1="15" x2="17" y2="15" stroke="#4caf50" stroke-width="1.8"
    stroke-linecap="round"/>
  <line x1="10" y1="18" x2="14" y2="18" stroke="#4caf50" stroke-width="1.5"
    stroke-linecap="round" stroke-dasharray="2,2"/>
`);
}

function makeFileIcon(): string {
  return svg('0 0 24 24', 24, 24, `
  <!-- File body -->
  <path d="M4 2 L14 2 L20 8 L20 22 L4 22 Z"
    fill="#e3f2fd" stroke="#1565c0" stroke-width="1.2" stroke-linejoin="round"/>
  <!-- Folded corner -->
  <path d="M14 2 L14 8 L20 8 Z"
    fill="#bbdefb" stroke="#1565c0" stroke-width="1.2" stroke-linejoin="round"/>
  <!-- Content lines -->
  <line x1="7" y1="13" x2="17" y2="13" stroke="#90a4ae" stroke-width="1.5"
    stroke-linecap="round"/>
  <line x1="7" y1="16" x2="17" y2="16" stroke="#90a4ae" stroke-width="1.5"
    stroke-linecap="round"/>
  <line x1="7" y1="19" x2="13" y2="19" stroke="#90a4ae" stroke-width="1.5"
    stroke-linecap="round"/>
`);
}

function makeBrowserIcon(): string {
  return svg('0 0 24 24', 24, 24, `
  <!-- Globe circle -->
  <circle cx="12" cy="12" r="10.5" fill="#e3f2fd" stroke="#1565c0" stroke-width="1.2"/>
  <!-- Meridian lines -->
  <ellipse cx="12" cy="12" rx="4.5" ry="10.5" fill="none"
    stroke="#1565c0" stroke-width="1"/>
  <!-- Latitude lines -->
  <line x1="1.5" y1="12" x2="22.5" y2="12" stroke="#1565c0" stroke-width="1"/>
  <path d="M3 7.5 Q12 9.5 21 7.5" fill="none" stroke="#1565c0" stroke-width="1"/>
  <path d="M3 16.5 Q12 14.5 21 16.5" fill="none" stroke="#1565c0" stroke-width="1"/>
`);
}

// ---------------------------------------------------------------------------
// Badges (16x16 viewBox)
// ---------------------------------------------------------------------------

function makeShieldPath(): string {
  // A shield-like shape using a path
  return 'M8 1 L15 4 L15 9 Q15 14 8 16 Q1 14 1 9 L1 4 Z';
}

function makeBadgeGold(): string {
  return svg('0 0 16 16', 16, 16, `
  <path d="${makeShieldPath()}" fill="#f9a825" stroke="#e65100" stroke-width="1"
    stroke-linejoin="round"/>
  <path d="${makeShieldPath()}" fill="url(#goldGrad)" stroke="none"/>
  <defs>
    <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffee58"/>
      <stop offset="100%" stop-color="#f57f17"/>
    </linearGradient>
  </defs>
  <!-- Star -->
  <polygon points="8,4 9,7 12,7 9.5,9 10.5,12 8,10 5.5,12 6.5,9 4,7 7,7"
    fill="#fff" opacity="0.9"/>
`);
}

function makeBadgeBlue(): string {
  return svg('0 0 16 16', 16, 16, `
  <path d="${makeShieldPath()}" fill="#1565c0" stroke="#0d47a1" stroke-width="1"
    stroke-linejoin="round"/>
  <path d="${makeShieldPath()}" fill="url(#blueGrad)" stroke="none"/>
  <defs>
    <linearGradient id="blueGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#42a5f5"/>
      <stop offset="100%" stop-color="#0d47a1"/>
    </linearGradient>
  </defs>
  <!-- Check mark -->
  <polyline points="4,8 7,11 12,5" fill="none" stroke="#fff"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
`);
}

function makeBadgeGreen(): string {
  return svg('0 0 16 16', 16, 16, `
  <path d="${makeShieldPath()}" fill="#2e7d32" stroke="#1b5e20" stroke-width="1"
    stroke-linejoin="round"/>
  <path d="${makeShieldPath()}" fill="url(#greenGrad)" stroke="none"/>
  <defs>
    <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#66bb6a"/>
      <stop offset="100%" stop-color="#1b5e20"/>
    </linearGradient>
  </defs>
  <!-- Leaf / plant symbol -->
  <path d="M8 12 Q8 7 12 5 Q10 9 8 12 Z" fill="#fff" opacity="0.85"/>
  <path d="M8 12 Q8 7 4 5 Q6 9 8 12 Z" fill="#fff" opacity="0.65"/>
  <line x1="8" y1="12" x2="8" y2="6" stroke="#fff" stroke-width="1"
    stroke-linecap="round" opacity="0.8"/>
`);
}

// ---------------------------------------------------------------------------
// Speech bubble (9-slice compatible)
// ---------------------------------------------------------------------------

function makeSpeechBubble(): string {
  // 200x120 viewBox, rounded rectangle with tail at bottom-left
  // 9-slice guides: left=16, right=184, top=16, bottom=88
  return svg('0 0 200 120', 200, 120, `
  <!-- Shadow -->
  <path d="
    M20 6
    L180 6 Q194 6 194 20
    L194 84 Q194 98 180 98
    L50 98 L30 114 L36 98
    L20 98 Q6 98 6 84
    L6 20 Q6 6 20 6 Z
  " fill="rgba(0,0,0,0.15)" transform="translate(2,2)"/>
  <!-- Main bubble body -->
  <path d="
    M20 4
    L180 4 Q196 4 196 20
    L196 82 Q196 98 180 98
    L50 98 L28 116 L34 98
    L20 98 Q4 98 4 82
    L4 20 Q4 4 20 4 Z
  " fill="#ffffff" stroke="#d0d0d0" stroke-width="1.5"/>
  <!-- 9-slice guide markers (invisible but semantic) -->
  <!-- Corner radius: 16px — slice at x=16, x=184, y=16, y=82 -->
`);
}

// ---------------------------------------------------------------------------
// Thinking indicator (animated dots)
// ---------------------------------------------------------------------------

function makeThinkingIndicator(): string {
  return svg('0 0 60 24', 60, 24, `
  ${cssBlock(`
    @keyframes dot-bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
      40%            { transform: translateY(-6px); opacity: 1; }
    }
    .d1 { animation: dot-bounce 1.4s ease-in-out infinite; animation-delay: 0s; }
    .d2 { animation: dot-bounce 1.4s ease-in-out infinite; animation-delay: 0.2s; }
    .d3 { animation: dot-bounce 1.4s ease-in-out infinite; animation-delay: 0.4s; }
  `)}
  <!-- Bubble background -->
  <rect x="0" y="0" width="60" height="24" rx="12" ry="12"
    fill="#f0f0f0" stroke="#d0d0d0" stroke-width="1"/>
  <!-- Three animated dots -->
  <circle class="d1" cx="15" cy="12" r="4" fill="#9e9e9e"/>
  <circle class="d2" cx="30" cy="12" r="4" fill="#9e9e9e"/>
  <circle class="d3" cx="45" cy="12" r="4" fill="#9e9e9e"/>
`);
}

// ---------------------------------------------------------------------------
// File list builder
// ---------------------------------------------------------------------------

function buildFileList(): SvgFile[] {
  return [
    // Root effects
    {
      relativePath: 'speech_bubble.svg',
      content: makeSpeechBubble(),
    },
    {
      relativePath: 'thinking_indicator.svg',
      content: makeThinkingIndicator(),
    },
    // Status icons
    {
      relativePath: 'status_icons/checkmark_green.svg',
      content: makeCheckmarkGreen(),
    },
    {
      relativePath: 'status_icons/exclamation_red.svg',
      content: makeExclamationRed(),
    },
    {
      relativePath: 'status_icons/gear_spinning.svg',
      content: makeGearSpinning(),
    },
    {
      relativePath: 'status_icons/terminal_icon.svg',
      content: makeTerminalIcon(),
    },
    {
      relativePath: 'status_icons/file_icon.svg',
      content: makeFileIcon(),
    },
    {
      relativePath: 'status_icons/browser_icon.svg',
      content: makeBrowserIcon(),
    },
    // Badges
    {
      relativePath: 'badges/badge_gold.svg',
      content: makeBadgeGold(),
    },
    {
      relativePath: 'badges/badge_blue.svg',
      content: makeBadgeBlue(),
    },
    {
      relativePath: 'badges/badge_green.svg',
      content: makeBadgeGreen(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Effects & Icons SVG Generator ===');

  const files = buildFileList();

  for (const file of files) {
    const filePath = path.join(EFFECTS_DIR, file.relativePath);
    const dir = path.dirname(filePath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');

    const sizeBytes = Buffer.byteLength(file.content, 'utf-8');
    console.log(`  Wrote ${file.relativePath} (${sizeBytes}B)`);
  }

  console.log('');
  console.log(`Done! Generated ${files.length} SVG files.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
