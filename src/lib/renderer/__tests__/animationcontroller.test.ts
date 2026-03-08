// Unit tests for AnimationController FSM
// AgentSprite is mocked without importing PIXI types

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnimationController, type AnimatableSprite } from "../AnimationController";

function makeMockSprite(): AnimatableSprite {
  return {
    alpha: 1,
    hideThinkingIndicator: vi.fn(),
    hideToolIcon: vi.fn(),
    hideSpeechBubble: vi.fn(),
    showSpeechBubble: vi.fn(),
    showThinkingIndicator: vi.fn(),
    showToolIcon: vi.fn(),
    showTaskComplete: vi.fn(),
    showError: vi.fn(),
    playAnimation: vi.fn(),
  };
}

describe("test_state_transition_valid", () => {
  it("idle -> thinking is allowed", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("thinking");
    expect(ctrl.getStatus()).toBe("thinking");
  });

  it("thinking -> responding is allowed", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("thinking");
    ctrl.transition("responding");
    expect(ctrl.getStatus()).toBe("responding");
  });

  it("responding -> task_complete is allowed", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("thinking");
    ctrl.transition("responding");
    ctrl.transition("task_complete");
    expect(ctrl.getStatus()).toBe("task_complete");
  });

  it("idle -> error is allowed (interrupt)", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("error");
    expect(ctrl.getStatus()).toBe("error");
  });

  it("error -> walking_to_desk is allowed (leave desk on error)", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("error");
    ctrl.destroy();
    ctrl.transition("walking_to_desk");
    expect(ctrl.getStatus()).toBe("walking_to_desk");
  });
});

describe("test_state_transition_invalid", () => {
  it("idle -> task_complete is rejected (status stays idle)", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ctrl.transition("task_complete");

    expect(ctrl.getStatus()).toBe("idle");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("task_complete -> thinking is rejected", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("thinking");
    ctrl.transition("task_complete");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ctrl.transition("thinking");

    expect(ctrl.getStatus()).toBe("task_complete");
    warnSpy.mockRestore();
    ctrl.destroy();
  });
});

describe("test_animation_mapping", () => {
  let sprite: AnimatableSprite;
  let ctrl: AnimationController;

  beforeEach(() => {
    sprite = makeMockSprite();
    ctrl = new AnimationController(sprite);
  });

  it("idle status plays idle_stand animation", () => {
    ctrl.transition("thinking");
    ctrl.transition("idle");
    expect(sprite.playAnimation).toHaveBeenCalledWith("idle_stand");
  });

  it("thinking status plays thinking animation", () => {
    ctrl.transition("thinking");
    expect(sprite.playAnimation).toHaveBeenCalledWith("thinking");
  });

  it("responding status plays typing animation", () => {
    ctrl.transition("thinking");
    ctrl.transition("responding");
    expect(sprite.playAnimation).toHaveBeenCalledWith("typing");
  });

  it("tool_use status plays typing animation", () => {
    ctrl.transition("thinking");
    ctrl.transition("tool_use");
    expect(sprite.playAnimation).toHaveBeenCalledWith("typing");
  });

  it("task_complete status plays celebrating animation", () => {
    ctrl.transition("thinking");
    ctrl.transition("task_complete");
    expect(sprite.playAnimation).toHaveBeenCalledWith("celebrating");
    ctrl.destroy();
  });

  it("error status plays frustrated animation", () => {
    ctrl.transition("error");
    expect(sprite.playAnimation).toHaveBeenCalledWith("frustrated");
    ctrl.destroy();
  });
});

describe("AnimationController — walking queue", () => {
  it("queues state changes while walking and applies after walkComplete()", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.walkStarted();
    ctrl.transition("thinking"); // queued — agent is walking

    expect(ctrl.getStatus()).toBe("idle"); // still idle

    ctrl.walkComplete(); // flush pending
    expect(ctrl.getStatus()).toBe("thinking");
  });

  it("error state interrupts walk immediately", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.walkStarted();
    ctrl.transition("error"); // interrupt

    expect(ctrl.getStatus()).toBe("error");
    ctrl.destroy();
  });

  it("offline state interrupts walk immediately", () => {
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.walkStarted();
    ctrl.transition("offline");

    expect(ctrl.getStatus()).toBe("offline");
  });
});

describe("test_auto_transition_task_complete", () => {
  it("transitions to idle automatically after 3s", () => {
    vi.useFakeTimers();
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("thinking");
    ctrl.transition("task_complete");
    expect(ctrl.getStatus()).toBe("task_complete");

    vi.advanceTimersByTime(3100);
    expect(ctrl.getStatus()).toBe("idle");

    vi.useRealTimers();
    ctrl.destroy();
  });

  it("error auto-transitions to idle after 5s", () => {
    vi.useFakeTimers();
    const sprite = makeMockSprite();
    const ctrl = new AnimationController(sprite);

    ctrl.transition("error");
    vi.advanceTimersByTime(5100);

    expect(ctrl.getStatus()).toBe("idle");

    vi.useRealTimers();
    ctrl.destroy();
  });
});
