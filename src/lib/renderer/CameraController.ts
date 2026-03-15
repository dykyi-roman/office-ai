// Camera controller — pan, zoom, follow-agent mode for the isometric scene
// Operates on a PIXI.Container that acts as the "world" viewport

import { Container, Ticker } from "pixi.js";
import { isoToScreen } from "./utils/isometric";
import type { AgentSprite } from "./AgentSprite";

/** Zoom range */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;

/** Smooth zoom speed (fraction per frame at 60fps) */
const ZOOM_SMOOTH = 0.12;

/** Zoom step per scroll wheel notch */
const ZOOM_STEP = 0.1;

/** Keyboard pan speed in pixels per second */
const PAN_SPEED_PX = 300;

/** Follow-mode smoothing factor */
const FOLLOW_SMOOTH = 0.08;

/** Max pointer movement (px) to still count as a click */
const CLICK_THRESHOLD_PX = 5;

/** Max time (ms) between pointerdown and pointerup for a click */
const CLICK_TIME_MS = 300;

/** Keyboard key flags */
interface KeyState {
  ArrowLeft: boolean;
  ArrowRight: boolean;
  ArrowUp: boolean;
  ArrowDown: boolean;
  Equal: boolean;   // + key
  Minus: boolean;   // - key
}

/**
 * Controls the isometric world container's position and scale.
 * Attach to a DOM canvas element for mouse/keyboard events.
 */
export class CameraController {
  private readonly world: Container;
  private viewportW = 0;
  private viewportH = 0;

  // Zoom
  private currentZoom = 1;
  private targetZoom = 1;

  // Pan
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private worldStartX = 0;
  private worldStartY = 0;

  // Click detection
  private clickStartX = 0;
  private clickStartY = 0;
  private clickStartTime = 0;
  private onCanvasClick: ((screenX: number, screenY: number) => void) | null = null;

  // Follow mode
  private followTarget: AgentSprite | null = null;

  // Office bounds (screen pixels at zoom=1)
  private boundW = 0;
  private boundH = 0;

  // Keyboard state
  private readonly keys: KeyState = {
    ArrowLeft: false,
    ArrowRight: false,
    ArrowUp: false,
    ArrowDown: false,
    Equal: false,
    Minus: false,
  };

  // Bound event listeners stored for cleanup
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;

  private canvas: HTMLElement | null = null;

  constructor(world: Container) {
    this.world = world;

    this.onWheel = this.handleWheel.bind(this);
    this.onPointerDown = this.handlePointerDown.bind(this);
    this.onPointerMove = this.handlePointerMove.bind(this);
    this.onPointerUp = this.handlePointerUp.bind(this);
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onKeyUp = this.handleKeyUp.bind(this);

    Ticker.shared.add(this.tick, this);
  }

  /**
   * Attach DOM event listeners to the canvas element.
   * Must be called after PixiJS application is initialised.
   */
  attach(canvas: HTMLElement, viewportW: number, viewportH: number): void {
    this.canvas = canvas;
    this.viewportW = viewportW;
    this.viewportH = viewportH;

    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerUp);

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  /**
   * Remove all event listeners and stop the ticker.
   */
  detach(): void {
    Ticker.shared.remove(this.tick, this);

    if (this.canvas !== null) {
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("pointerleave", this.onPointerUp);
      this.canvas = null;
    }

    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  /**
   * Update viewport dimensions on resize.
   */
  resize(w: number, h: number): void {
    this.viewportW = w;
    this.viewportH = h;
  }

  /**
   * Set the maximum world bounds (unscaled pixels) for panning limits.
   * Call this after the office layout is loaded.
   */
  setWorldBounds(worldCols: number, worldRows: number): void {
    const br = isoToScreen(worldCols, worldRows);
    this.boundW = Math.abs(br.x) + 256;
    this.boundH = br.y + 128;
  }

  /**
   * Smoothly centre the camera on the given isometric grid position.
   */
  centerOn(col: number, row: number): void {
    this.followTarget = null;
    const screen = isoToScreen(col, row);
    const targetX = this.viewportW / 2 - screen.x * this.currentZoom;
    const targetY = this.viewportH / 2 - screen.y * this.currentZoom;
    this.world.x = targetX;
    this.world.y = targetY;
    this.clampPosition();
  }

  /**
   * Enable follow mode — camera tracks the given AgentSprite.
   * Pass null to disable follow mode.
   */
  follow(sprite: AgentSprite | null): void {
    this.followTarget = sprite;
  }

  /**
   * Return the current zoom level.
   */
  getZoom(): number {
    return this.currentZoom;
  }

  /**
   * Set a callback invoked when the user clicks (not drags) on the canvas.
   */
  setClickHandler(handler: (screenX: number, screenY: number) => void): void {
    this.onCanvasClick = handler;
  }

  // ---------------------------------------------------------------------------
  // Private ticker
  // ---------------------------------------------------------------------------

  private readonly tick = (ticker: Ticker): void => {
    const dt = ticker.deltaMS / 1000; // seconds

    // Smooth zoom
    if (Math.abs(this.targetZoom - this.currentZoom) > 0.001) {
      this.currentZoom +=
        (this.targetZoom - this.currentZoom) * ZOOM_SMOOTH;
      this.world.scale.set(this.currentZoom);
      this.clampPosition();
    }

    // Keyboard pan
    let panDX = 0;
    let panDY = 0;
    if (this.keys.ArrowLeft) panDX += PAN_SPEED_PX * dt;
    if (this.keys.ArrowRight) panDX -= PAN_SPEED_PX * dt;
    if (this.keys.ArrowUp) panDY += PAN_SPEED_PX * dt;
    if (this.keys.ArrowDown) panDY -= PAN_SPEED_PX * dt;

    if (panDX !== 0 || panDY !== 0) {
      this.followTarget = null;
      this.world.x += panDX;
      this.world.y += panDY;
      this.clampPosition();
    }

    // Keyboard zoom
    if (this.keys.Equal) {
      this.targetZoom = Math.min(this.targetZoom + ZOOM_STEP * dt * 3, MAX_ZOOM);
    }
    if (this.keys.Minus) {
      this.targetZoom = Math.max(this.targetZoom - ZOOM_STEP * dt * 3, MIN_ZOOM);
    }

    // Follow mode
    if (this.followTarget !== null) {
      const fx = this.followTarget.x;
      const fy = this.followTarget.y;
      const desiredX = this.viewportW / 2 - fx * this.currentZoom;
      const desiredY = this.viewportH / 2 - fy * this.currentZoom;
      this.world.x += (desiredX - this.world.x) * FOLLOW_SMOOTH;
      this.world.y += (desiredY - this.world.y) * FOLLOW_SMOOTH;
    }
  };

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    this.targetZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.targetZoom + delta));
  }

  private handlePointerDown(e: PointerEvent): void {
    this.isPanning = true;
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;
    this.worldStartX = this.world.x;
    this.worldStartY = this.world.y;
    this.clickStartX = e.clientX;
    this.clickStartY = e.clientY;
    this.clickStartTime = Date.now();
    this.followTarget = null;
    (e.currentTarget as HTMLElement | null)?.setPointerCapture(e.pointerId);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.isPanning) return;
    const dx = e.clientX - this.panStartX;
    const dy = e.clientY - this.panStartY;
    this.world.x = this.worldStartX + dx;
    this.world.y = this.worldStartY + dy;
    this.clampPosition();
  }

  private handlePointerUp(e: PointerEvent): void {
    this.isPanning = false;

    const dx = e.clientX - this.clickStartX;
    const dy = e.clientY - this.clickStartY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = Date.now() - this.clickStartTime;

    if (dist < CLICK_THRESHOLD_PX && elapsed < CLICK_TIME_MS && this.onCanvasClick) {
      this.onCanvasClick(e.clientX, e.clientY);
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.code in this.keys) {
      this.keys[e.code as keyof KeyState] = true;
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.code in this.keys) {
      this.keys[e.code as keyof KeyState] = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private clampPosition(): void {
    if (this.boundW === 0) return;

    const scaledW = this.boundW * this.currentZoom;
    const scaledH = this.boundH * this.currentZoom;

    const minX = this.viewportW - scaledW;
    const minY = this.viewportH - scaledH;

    this.world.x = Math.min(this.viewportW * 0.5, Math.max(minX, this.world.x));
    this.world.y = Math.min(this.viewportH * 0.5, Math.max(minY, this.world.y));
  }
}
