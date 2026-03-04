// Animation state machine for agent sprites
// Maps Status -> animation name, handles transitions, queues and auto-transitions

import type { Status } from "$lib/types/agent";

/**
 * Subset of AgentSprite methods required by the FSM.
 * Declared as an interface so AnimationController has no hard dependency on
 * the PixiJS-heavy AgentSprite class — simplifies unit-testing.
 */
export interface AnimatableSprite {
  alpha: number;
  playAnimation(name: string): void;
  showThinkingIndicator(): void;
  hideThinkingIndicator(): void;
  showToolIcon(tool: "terminal" | "file" | "browser"): void;
  hideToolIcon(): void;
  showSpeechBubble(text: string, durationMs?: number): void;
  hideSpeechBubble(): void;
  showTaskComplete(): void;
  showError(): void;
}

/** Auto-transition descriptor — move to `to` after `afterMs` ms */
interface AutoTransition {
  to: Status;
  afterMs: number;
}

/** One state definition in the FSM */
interface AnimState {
  status: Status;
  animation: string;
  enterAction?: (sprite: AnimatableSprite) => void;
  exitAction?: (sprite: AnimatableSprite) => void;
  autoTransition?: AutoTransition;
}

/** Valid FSM transitions: key = current status, value = set of allowed next statuses */
const VALID_TRANSITIONS: Readonly<Record<Status, ReadonlySet<Status>>> = {
  idle: new Set<Status>([
    "walking_to_desk",
    "thinking",
    "responding",
    "tool_use",
    "collaboration",
    "error",
    "offline",
  ]),
  walking_to_desk: new Set<Status>([
    "idle",
    "thinking",
    "responding",
    "tool_use",
    "collaboration",
    "error",
    "offline",
  ]),
  thinking: new Set<Status>([
    "idle",
    "walking_to_desk",
    "responding",
    "tool_use",
    "collaboration",
    "task_complete",
    "error",
    "offline",
  ]),
  responding: new Set<Status>([
    "idle",
    "walking_to_desk",
    "thinking",
    "tool_use",
    "task_complete",
    "error",
    "offline",
  ]),
  tool_use: new Set<Status>([
    "idle",
    "walking_to_desk",
    "thinking",
    "responding",
    "task_complete",
    "error",
    "offline",
  ]),
  collaboration: new Set<Status>([
    "idle",
    "walking_to_desk",
    "thinking",
    "responding",
    "task_complete",
    "error",
    "offline",
  ]),
  task_complete: new Set<Status>(["idle", "offline"]),
  error: new Set<Status>(["idle", "offline"]),
  offline: new Set<Status>(["idle"]),
};

/** States that interrupt a walking queue immediately */
const INTERRUPT_WALK: ReadonlySet<Status> = new Set<Status>([
  "error",
  "offline",
]);

/** FSM state table */
const STATES: Readonly<Record<Status, AnimState>> = {
  idle: {
    status: "idle",
    animation: "idle_stand",
    enterAction: (sprite) => {
      sprite.hideThinkingIndicator();
      sprite.hideToolIcon();
      sprite.hideSpeechBubble();
    },
  },
  walking_to_desk: {
    status: "walking_to_desk",
    animation: "walk_down", // direction overridden per step by AnimatableSprite
  },
  thinking: {
    status: "thinking",
    animation: "thinking",
    enterAction: (sprite) => {
      sprite.hideToolIcon();
      sprite.hideSpeechBubble();
    },
  },
  responding: {
    status: "responding",
    animation: "typing",
    enterAction: (sprite) => {
      sprite.hideToolIcon();
    },
    exitAction: (sprite) => {
      sprite.hideSpeechBubble();
    },
  },
  tool_use: {
    status: "tool_use",
    animation: "typing",
    exitAction: (sprite) => {
      sprite.hideToolIcon();
    },
  },
  collaboration: {
    status: "collaboration",
    animation: "idle_stand",
    enterAction: (sprite) => {
      sprite.hideThinkingIndicator();
      sprite.hideToolIcon();
    },
  },
  task_complete: {
    status: "task_complete",
    animation: "celebrating",
    enterAction: (sprite) => {
      sprite.hideThinkingIndicator();
      sprite.hideToolIcon();
      sprite.hideSpeechBubble();
      sprite.showTaskComplete();
    },
    autoTransition: { to: "idle", afterMs: 3000 },
  },
  error: {
    status: "error",
    animation: "frustrated",
    enterAction: (sprite) => {
      sprite.hideThinkingIndicator();
      sprite.hideToolIcon();
      sprite.hideSpeechBubble();
      sprite.showError();
    },
    autoTransition: { to: "idle", afterMs: 5000 },
  },
  offline: {
    status: "offline",
    animation: "idle_stand",
    enterAction: (sprite) => {
      sprite.hideThinkingIndicator();
      sprite.hideToolIcon();
      sprite.hideSpeechBubble();
    },
  },
};

/**
 * Per-agent animation FSM.
 * Bind one instance to each AnimatableSprite.
 */
export class AnimationController {
  private currentStatus: Status = "idle";
  private isWalking = false;
  private pendingStatus: Status | null = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingVisible = false;

  constructor(private readonly sprite: AnimatableSprite) {}

  /**
   * Request a state transition.
   * If the agent is currently walking, non-interrupt transitions are queued
   * until the walk completes.
   *
   * @param next - Target status
   */
  transition(next: Status): void {
    if (!this.isTransitionValid(this.currentStatus, next)) {
      console.warn(
        `[AnimationController] Invalid transition: ${this.currentStatus} -> ${next}`
      );
      return;
    }

    // If walking and not an interrupt state — queue
    if (this.isWalking && !INTERRUPT_WALK.has(next)) {
      this.pendingStatus = next;
      return;
    }

    this.applyTransition(next);
  }

  /**
   * Notify the controller that a walk has started.
   * Queued transitions will execute only after walkComplete() is called.
   */
  walkStarted(): void {
    this.isWalking = true;
  }

  /**
   * Notify the controller that the walk has finished.
   * Applies any pending transition.
   */
  walkComplete(): void {
    this.isWalking = false;
    if (this.pendingStatus !== null) {
      const next = this.pendingStatus;
      this.pendingStatus = null;
      this.applyTransition(next);
    }
  }

  /**
   * Return the current status.
   */
  getStatus(): Status {
    return this.currentStatus;
  }

  /**
   * Tear down timers when the sprite is destroyed.
   */
  destroy(): void {
    this.clearAutoTimer();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private applyTransition(next: Status): void {
    this.clearAutoTimer();

    const exitState = STATES[this.currentStatus];
    exitState.exitAction?.(this.sprite);

    this.currentStatus = next;
    const enterState = STATES[next];

    // Play animation
    this.sprite.playAnimation(enterState.animation);

    // Run enter actions
    enterState.enterAction?.(this.sprite);

    // Show thinking indicator for all work states (thinking, responding, tool_use).
    // Always re-create: enterAction/exitAction may call clearStatusIndicator()
    // which destroys dots, so we must restore them after every work transition.
    const WORK_STATES: ReadonlySet<Status> = new Set<Status>(["thinking", "responding", "tool_use"]);
    if (WORK_STATES.has(next)) {
      this.thinkingVisible = true;
      this.sprite.showThinkingIndicator();
    } else if (this.thinkingVisible) {
      this.thinkingVisible = false;
      this.sprite.hideThinkingIndicator();
    }

    // Schedule auto-transition if defined
    if (enterState.autoTransition !== undefined) {
      const { to, afterMs } = enterState.autoTransition;
      this.autoTimer = setTimeout(() => {
        this.transition(to);
      }, afterMs);
    }

    // Offline = hide sprite
    if (next === "offline") {
      this.sprite.alpha = 0;
    } else if (this.sprite.alpha === 0) {
      this.sprite.alpha = 1;
    }
  }

  private isTransitionValid(from: Status, to: Status): boolean {
    return VALID_TRANSITIONS[from].has(to);
  }

  private clearAutoTimer(): void {
    if (this.autoTimer !== null) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
  }

}

/**
 * Compute the walking animation name based on movement direction.
 * dx/dy are the delta between current and next tile in screen space.
 */
export function walkAnimationForDirection(dx: number, dy: number): string {
  // Horizontal movement dominates
  if (Math.abs(dx) > Math.abs(dy)) {
    return "walk_side";
  }
  return dy > 0 ? "walk_down" : "walk_up";
}
