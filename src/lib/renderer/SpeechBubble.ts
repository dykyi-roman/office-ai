// Speech bubble drawn with PixiJS Graphics — rounded rect + tail + wrapped text
// Appears with a scale 0→1 animation (150ms) and fades out over 300ms

import { Container, Graphics, Text, TextStyle, Ticker } from "pixi.js";

/** Maximum bubble width in pixels before text wraps */
const MAX_BUBBLE_WIDTH = 200;

/** Internal padding around text */
const PADDING = 10;

/** Tail height in pixels */
const TAIL_HEIGHT = 10;

/** Corner radius for the rounded rectangle */
const CORNER_RADIUS = 8;

/** Appear animation duration in milliseconds */
const APPEAR_MS = 150;

/** Disappear (fade-out) duration in milliseconds */
const DISAPPEAR_MS = 300;

/** Text style for bubble content */
const BUBBLE_TEXT_STYLE = new TextStyle({
  fontFamily: "Arial, sans-serif",
  fontSize: 12,
  fill: 0x222222,
  wordWrap: true,
  wordWrapWidth: MAX_BUBBLE_WIDTH - PADDING * 2,
  breakWords: true,
  align: "center",
  lineHeight: 16,
});

/**
 * PixiJS speech bubble.
 * Extends Container so it can be added to any layer.
 * Position the container at the agent's head — the bubble renders above it.
 */
export class SpeechBubble extends Container {
  private readonly bg: Graphics;
  private readonly textNode: Text;

  private dismissTimer: number | null = null;
  private animPhase: "idle" | "appearing" | "visible" | "disappearing" = "idle";
  private animElapsed = 0;

  constructor() {
    super();

    this.bg = new Graphics();
    this.textNode = new Text({ text: "", style: BUBBLE_TEXT_STYLE });
    this.textNode.anchor.set(0.5, 0);

    this.addChild(this.bg);
    this.addChild(this.textNode);

    this.visible = false;
    this.scale.set(0);
    this.pivot.set(0, 0);
  }

  /**
   * Display the bubble with the provided text.
   * The bubble auto-dismisses after `durationMs` milliseconds.
   *
   * @param text - Text to display inside the bubble
   * @param durationMs - How long the bubble stays visible (excluding animations)
   */
  show(text: string, durationMs: number): void {
    this.clearDismissTimer();

    this.textNode.text = text;
    this.drawBackground();

    this.visible = true;
    this.alpha = 1;

    // Start appear animation
    this.animPhase = "appearing";
    this.animElapsed = 0;
    this.scale.set(0);

    Ticker.shared.add(this.tick, this);

    // Schedule auto-dismiss after appear + visible duration
    this.dismissTimer = window.setTimeout(() => {
      this.hide();
    }, APPEAR_MS + durationMs);
  }

  /**
   * Immediately begin the disappear animation.
   */
  hide(): void {
    this.clearDismissTimer();
    if (this.animPhase === "disappearing" || this.animPhase === "idle") return;

    this.animPhase = "disappearing";
    this.animElapsed = 0;
    // Ticker.shared.add is idempotent for the same listener+context pair in PixiJS v8
    Ticker.shared.add(this.tick, this);
  }

  /** @override — clean up resources */
  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.clearDismissTimer();
    Ticker.shared.remove(this.tick, this);
    super.destroy(options);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private readonly tick = (ticker: Ticker): void => {
    const dt = ticker.deltaMS;

    if (this.animPhase === "appearing") {
      this.animElapsed += dt;
      const t = Math.min(this.animElapsed / APPEAR_MS, 1);
      const scale = this.easeOut(t);
      this.scale.set(scale);

      if (t >= 1) {
        this.animPhase = "visible";
        this.scale.set(1);
      }
      return;
    }

    if (this.animPhase === "disappearing") {
      this.animElapsed += dt;
      const t = Math.min(this.animElapsed / DISAPPEAR_MS, 1);
      this.alpha = 1 - t;

      if (t >= 1) {
        this.visible = false;
        this.alpha = 1;
        this.animPhase = "idle";
        Ticker.shared.remove(this.tick, this);
      }
    }
  };

  private drawBackground(): void {
    const textW = this.textNode.width;
    const textH = this.textNode.height;

    const bubbleW = Math.min(textW + PADDING * 2, MAX_BUBBLE_WIDTH);
    const bubbleH = textH + PADDING * 2;

    this.bg.clear();

    // Drop shadow
    this.bg.roundRect(
      -bubbleW / 2 + 2,
      -bubbleH - TAIL_HEIGHT + 2,
      bubbleW,
      bubbleH,
      CORNER_RADIUS
    );
    this.bg.fill({ color: 0x000000, alpha: 0.15 });

    // White bubble body
    this.bg.roundRect(
      -bubbleW / 2,
      -bubbleH - TAIL_HEIGHT,
      bubbleW,
      bubbleH,
      CORNER_RADIUS
    );
    this.bg.fill({ color: 0xffffff, alpha: 0.95 });

    // Bubble border
    this.bg.roundRect(
      -bubbleW / 2,
      -bubbleH - TAIL_HEIGHT,
      bubbleW,
      bubbleH,
      CORNER_RADIUS
    );
    this.bg.stroke({ color: 0xcccccc, width: 1 });

    // Tail triangle pointing downward
    this.bg.moveTo(-6, -TAIL_HEIGHT);
    this.bg.lineTo(6, -TAIL_HEIGHT);
    this.bg.lineTo(0, 0);
    this.bg.closePath();
    this.bg.fill({ color: 0xffffff, alpha: 0.95 });

    // Position text centred inside bubble
    this.textNode.x = 0;
    this.textNode.y = -bubbleH - TAIL_HEIGHT + PADDING;
    this.textNode.anchor.set(0.5, 0);
  }

  private clearDismissTimer(): void {
    if (this.dismissTimer !== null) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  /** Quadratic ease-out for appear animation */
  private easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
  }
}
