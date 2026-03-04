// AgentSprite — animated office-employee character
// Extends PIXI.Container; orchestrates body, nameLabel, statusIndicator, speechBubble

import {
  AnimatedSprite,
  Container,
  Graphics,
  Text,
  TextStyle,
  Texture,
  Ticker,
  type Spritesheet,
} from "pixi.js";
import type { AgentState, Status, Tier } from "$lib/types/agent";
import type { GridPosition } from "$lib/types/office";
import { getSetting } from "$lib/stores/settings.svelte";
import { isoToScreen } from "./utils/isometric";
import { AnimationController, walkAnimationForDirection } from "./AnimationController";
import { SpeechBubble } from "./SpeechBubble";

/** Walking speed in pixels per second */
const WALK_SPEED_PX = 120;

/** All agents render with the same visual tier (green hoodie) regardless of actual tier */
const VISUAL_TIER: Tier = "middle";

/** Thinking dot fill colour per tier */
const TIER_DOT_COLOR: Record<Tier, number> = {
  flagship: 0xffd700, // gold
  senior: 0x4a90e2,   // blue
  middle: 0x5cb85c,   // green
  junior: 0xaaaaaa,   // grey
};

/** Thinking dot stroke (darker variant) per tier */
const TIER_DOT_STROKE: Record<Tier, number> = {
  flagship: 0xb89b00,
  senior: 0x2d5a8e,
  middle: 0x3a7a3a,
  junior: 0x777777,
};

/** Name label text style */
const NAME_STYLE = new TextStyle({
  fontFamily: "Arial, sans-serif",
  fontSize: 11,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 3 },
  align: "center",
});

/** Status indicator icon colours */
const INDICATOR_COLORS = {
  tool: 0x9b59b6,
  complete: 0x2ecc71,
  error: 0xe74c3c,
} as const;

/** Sprite size from the agent spritesheet (frame is 64x64 pixels) */
const FRAME_SIZE = 64;

/**
 * Visual representation of a single AI agent in the isometric office.
 * All visual sub-components are children of this Container.
 */
export class AgentSprite extends Container {
  readonly agentId: string;

  private body: AnimatedSprite;

  /** Reference to the agent's spritesheet — used to switch animations */
  private readonly spritesheet: Spritesheet | null;

  private tier: Tier;
  private readonly nameLabel: Text;
  private readonly statusIndicator: Container;
  private readonly selectionHighlight: Graphics;
  private readonly speechBubble: SpeechBubble;

  private readonly animController: AnimationController;

  // Walking state
  private walkPath: GridPosition[] = [];
  private walkOnArrive: (() => void) | null = null;
  private currentGridPos: GridPosition = { col: 0, row: 0 };

  // Thinking bounce animation
  private _thinkingBounce: ((ticker: Ticker) => void) | null = null;

  constructor(agent: AgentState, spritesheet: Spritesheet | null) {
    super();

    this.agentId = agent.id;
    this.spritesheet = spritesheet;
    this.tier = agent.tier;
    this.currentGridPos = { col: 0, row: 0 };

    // Selection highlight (rendered beneath everything)
    this.selectionHighlight = new Graphics();
    this.drawSelectionHighlight(false);
    this.addChild(this.selectionHighlight);

    // Body — animated sprite from spritesheet
    this.body = this.createBody(agent.tier, spritesheet);
    this.addChild(this.body);

    // Name label below feet
    this.nameLabel = new Text({ text: agent.name, style: NAME_STYLE });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.y = -4;
    this.addChild(this.nameLabel);

    // Status indicator above head
    this.statusIndicator = new Container();
    this.statusIndicator.y = -FRAME_SIZE - 16;
    this.addChild(this.statusIndicator);

    // Speech bubble
    this.speechBubble = new SpeechBubble();
    this.speechBubble.y = -FRAME_SIZE - 8;
    this.addChild(this.speechBubble);

    // Animation FSM
    this.animController = new AnimationController(this);

    // Ticker for walk interpolation
    Ticker.shared.add(this.onTick, this);

    // Snap to initial grid position
    this.snapToGrid({ col: 0, row: 0 });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Transition to a new status.
   * Walking is queued unless the status is error/offline.
   */
  setState(status: Status): void {
    this.animController.transition(status);
  }

  /**
   * Feed a multi-step path for walking.
   * Replaces any existing walk in progress.
   */
  walkAlongPath(path: GridPosition[], onArrive?: () => void): void {
    if (path.length === 0) {
      onArrive?.();
      return;
    }
    this.walkPath = [...path];
    this.walkOnArrive = onArrive ?? null;
    this.animController.walkStarted();
  }

  /**
   * Begin walking to a single target tile.
   */
  walkTo(target: GridPosition, onArrive?: () => void): void {
    this.walkAlongPath([target], onArrive);
  }

  /** Display a speech bubble with auto-dismiss. Long text is truncated to 120 chars. */
  showSpeechBubble(text: string, durationMs?: number): void {
    const maxLen = 120;
    const display = text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
    const duration = durationMs ?? Math.max(3000, display.length * 50);
    this.speechBubble.show(display, duration);
  }

  /** Hide the speech bubble immediately */
  hideSpeechBubble(): void {
    this.speechBubble.hide();
  }

  /** Show the thinking indicator (three animated bouncing dots) */
  showThinkingIndicator(): void {
    this.clearStatusIndicator();

    const positions = [-12, 0, 12];
    const dots: Graphics[] = [];
    for (let i = 0; i < positions.length; i++) {
      const dot = new Graphics();
      dot.circle(0, 0, 6);
      dot.fill({ color: TIER_DOT_COLOR[this.tier] });
      dot.circle(0, 0, 6);
      dot.stroke({ color: TIER_DOT_STROKE[this.tier], width: 1 });
      dot.x = positions[i];
      dots.push(dot);
      this.statusIndicator.addChild(dot);
    }

    this.statusIndicator.visible = true;

    // Bouncing animation — staggered sine wave
    let elapsed = 0;
    const bounce = (ticker: Ticker): void => {
      elapsed += ticker.deltaMS / 1000;
      const speed = getSetting("animationSpeed");
      for (let i = 0; i < dots.length; i++) {
        dots[i].y = -Math.abs(Math.sin((elapsed * 4 * speed) + i * 0.8)) * 4;
      }
    };
    this._thinkingBounce = bounce;
    Ticker.shared.add(bounce);
  }

  /** Hide the thinking indicator */
  hideThinkingIndicator(): void {
    this.clearStatusIndicator();
  }

  /**
   * Show a tool-use icon above the agent's head.
   * @param tool - 'terminal', 'file', or 'browser'
   */
  showToolIcon(tool: "terminal" | "file" | "browser"): void {
    this.clearStatusIndicator();

    const toolColors: Record<string, number> = {
      terminal: 0x2c3e50,
      file: 0x3498db,
      browser: 0xe67e22,
    };

    const icon = new Graphics();
    icon.roundRect(-12, -12, 24, 24, 4);
    icon.fill({ color: toolColors[tool] ?? 0x888888 });

    const label = new Text({
      text: tool === "terminal" ? ">" : tool === "file" ? "F" : "B",
      style: new TextStyle({
        fontSize: 12,
        fill: 0xffffff,
        fontFamily: "monospace",
      }),
    });
    label.anchor.set(0.5);
    icon.addChild(label);

    this.statusIndicator.addChild(icon);
    this.statusIndicator.visible = true;
  }

  /** Hide the tool icon */
  hideToolIcon(): void {
    this.clearStatusIndicator();
  }

  /** Show a checkmark for task_complete with 2s fade-out */
  showTaskComplete(): void {
    this.clearStatusIndicator();

    const check = new Graphics();
    check.moveTo(-8, 0);
    check.lineTo(-2, 6);
    check.lineTo(8, -6);
    check.stroke({ color: INDICATOR_COLORS.complete, width: 3 });
    this.statusIndicator.addChild(check);
    this.statusIndicator.visible = true;

    let elapsed = 0;
    const fade = (ticker: Ticker): void => {
      elapsed += ticker.deltaMS;
      const t = Math.min(elapsed / 2000, 1);
      this.statusIndicator.alpha = 1 - t;
      if (t >= 1) {
        Ticker.shared.remove(fade);
        this.clearStatusIndicator();
        this.statusIndicator.alpha = 1;
      }
    };
    Ticker.shared.add(fade);
  }

  /** Show an error icon above the agent */
  showError(): void {
    this.clearStatusIndicator();

    const icon = new Graphics();
    icon.circle(0, 0, 10);
    icon.fill({ color: INDICATOR_COLORS.error });

    const cross = new Graphics();
    cross.moveTo(-5, -5);
    cross.lineTo(5, 5);
    cross.moveTo(5, -5);
    cross.lineTo(-5, 5);
    cross.stroke({ color: 0xffffff, width: 2 });
    icon.addChild(cross);

    this.statusIndicator.addChild(icon);
    this.statusIndicator.visible = true;
  }

  /**
   * Highlight or de-highlight this agent (selected state).
   */
  setSelected(selected: boolean): void {
    this.drawSelectionHighlight(selected);
  }

  /**
   * Update the sprite to reflect the latest AgentState received from the backend.
   */
  update(agent: AgentState): void {
    this.nameLabel.text = agent.name;
    this.tier = agent.tier;
    this.animController.transition(agent.status);
  }

  /**
   * Play a named animation from the spritesheet.
   * Called by AnimationController — do not invoke directly from outside.
   */
  playAnimation(name: string): void {
    if (this.spritesheet === null) return;

    const frames = this.spritesheet.animations[name];
    if (!frames || frames.length === 0) return;

    // Avoid restarting the same animation
    if (this.body.textures === frames) return;

    this.body.textures = frames;
    if (!this.body.playing) {
      this.body.play();
    }
  }

  /** Snap the sprite to a grid position without walking animation.
   *  Optional pixel offset prevents visual overlap when multiple agents share a tile. */
  snapToGrid(pos: GridPosition, pixelOffset?: { x: number; y: number }): void {
    this.currentGridPos = { ...pos };
    const screen = isoToScreen(pos.col, pos.row);
    this.x = screen.x + (pixelOffset?.x ?? 0);
    this.y = screen.y + (pixelOffset?.y ?? 0);
    this.zIndex = pos.col + pos.row;
  }

  /** Return the current grid position */
  getGridPosition(): GridPosition {
    return { ...this.currentGridPos };
  }

  /** @override — clean up ticker and children */
  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    Ticker.shared.remove(this.onTick, this);
    this.animController.destroy();
    this.speechBubble.destroy(options);
    super.destroy(options);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private readonly onTick = (ticker: Ticker): void => {
    const speedMultiplier = getSetting("animationSpeed");
    this.body.animationSpeed = 0.1 * speedMultiplier;

    if (this.walkPath.length === 0) return;

    const nextGrid = this.walkPath[0];
    const nextScreen = isoToScreen(nextGrid.col, nextGrid.row);
    const dx = nextScreen.x - this.x;
    const dy = nextScreen.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = (WALK_SPEED_PX * speedMultiplier * ticker.deltaMS) / 1000;

    // Update walk animation direction
    const animName = walkAnimationForDirection(dx, dy);
    this.playAnimation(animName);

    if (dist <= step) {
      // Snap to tile
      this.x = nextScreen.x;
      this.y = nextScreen.y;
      this.currentGridPos = { ...nextGrid };
      this.zIndex = nextGrid.col + nextGrid.row;
      this.walkPath.shift();

      if (this.walkPath.length === 0) {
        // Arrived at destination
        this.animController.walkComplete();
        const cb = this.walkOnArrive;
        this.walkOnArrive = null;
        cb?.();
      }
    } else {
      const factor = step / dist;
      this.x += dx * factor;
      this.y += dy * factor;
    }
  };

  private createBody(tier: Tier, spritesheet: Spritesheet | null): AnimatedSprite {
    if (spritesheet !== null) {
      const frames = spritesheet.animations["idle_stand"];
      if (frames && frames.length > 0) {
        const sprite = new AnimatedSprite(frames);
        sprite.anchor.set(0.5, 1);
        sprite.animationSpeed = 0.1;
        sprite.play();
        return sprite;
      }
    }

    // Fallback: single-frame coloured rectangle
    const fallbackTexture = this.createFallbackTexture(tier);
    const sprite = new AnimatedSprite([fallbackTexture]);
    sprite.anchor.set(0.5, 1);
    return sprite;
  }

  private createFallbackTexture(_tier: Tier): Texture {
    // RenderTexture creation requires an active renderer which may not be available
    // during construction. Use the built-in white texture as a safe fallback.
    return Texture.WHITE;
  }

  private drawSelectionHighlight(selected: boolean): void {
    this.selectionHighlight.clear();
    if (!selected) return;

    // Isometric ellipse outline at the agent's feet
    this.selectionHighlight.ellipse(0, 0, 36, 18);
    this.selectionHighlight.stroke({ color: 0x00aaff, width: 2, alpha: 0.85 });
  }

  private clearStatusIndicator(): void {
    if (this._thinkingBounce !== null) {
      Ticker.shared.remove(this._thinkingBounce);
      this._thinkingBounce = null;
    }
    this.statusIndicator.removeChildren();
    this.statusIndicator.visible = false;
  }
}
