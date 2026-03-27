/**
 * Claude DOM observer for claude.ai.
 *
 * Detects agent status and model via MutationObserver watching the
 * conversation container. Uses resilient CSS selectors with fallbacks.
 *
 * Status detection logic:
 * - thinking:   "Claude is thinking..." / pulsing dots indicator visible
 * - responding: streaming response container actively growing
 * - tool_use:   Artifacts panel open, code execution running, tool call blocks
 * - idle:       conversation complete, no active indicators
 * - task_complete: briefly after streaming ends (3s then idle)
 */

(function () {
  "use strict";

  const { BaseObserver } = window.__aiOfficeBase;

  // -------------------------------------------------------------------------
  // CSS selectors
  // -------------------------------------------------------------------------

  /** Thinking / processing indicators */
  const SEL_THINKING = [
    '[data-testid="thinking-indicator"]',
    ".thinking-indicator",
    ".pulsing-dots",
    '[aria-label="Claude is thinking"]',
    ".claude-thinking",
    ".thinking-placeholder",
    // The animated dots shown during streaming initialization
    ".fade-in-out",
  ];

  /** Stop / abort button visible during active streaming */
  const SEL_STOP_BUTTON = [
    'button[aria-label="Stop Response"]',
    'button[aria-label="Stop"]',
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
  ];

  /** Response container for the assistant messages (streaming area) */
  const SEL_RESPONSE_CONTAINER = [
    '[data-testid="assistant-message"]',
    ".assistant-message",
    ".claude-response",
    '[data-is-streaming="true"]',
    ".prose.streaming",
  ];

  /** Streaming attribute on response blocks */
  const SEL_STREAMING_RESPONSE = [
    '[data-is-streaming="true"]',
    ".streaming-response",
    ".message-content[data-streaming]",
  ];

  /** Tool use indicators: artifacts panel, code execution, tool calls */
  const SEL_TOOL_INDICATORS = [
    '[data-testid="artifact"]',
    ".artifact-panel",
    '[data-testid="tool-use"]',
    ".tool-use-block",
    ".tool-call-block",
    '[data-testid="code-execution"]',
    ".antml-tool-use",
    // The artifact side panel
    '[aria-label="Artifact"]',
    ".artifacts-panel",
  ];

  /** Model selector in the sidebar or header */
  const SEL_MODEL_SELECTOR = [
    '[data-testid="model-selector"]',
    ".model-selector button",
    'button[aria-label*="Claude"]',
    'button[aria-haspopup="listbox"]',
    "#model-selector",
    ".model-picker button",
    'select[name="model"]',
  ];

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /**
   * @param {string[]} selectors
   * @param {Document | Element} [root=document]
   * @returns {Element | null}
   */
  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  /**
   * @param {Element} el
   * @returns {boolean}
   */
  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  // -------------------------------------------------------------------------
  // Claude-specific observer
  // -------------------------------------------------------------------------

  class ClaudeObserver extends BaseObserver {
    constructor() {
      super("claude", "Claude");
      this._wasStreaming = false;
      this._taskCompleteTimer = null;
    }

    // -----------------------------------------------------------------------
    // Model detection
    // -----------------------------------------------------------------------

    detectModel() {
      // Try model selector button or dropdown
      const btn = queryFirst(SEL_MODEL_SELECTOR);
      if (btn) {
        const text = (btn.textContent || btn.getAttribute("aria-label") || "").trim();
        if (text) return this._normalizeModelName(text);
      }

      // Fallback: check for model name in page heading or meta
      const heading = document.querySelector("h1, h2");
      if (heading) {
        const text = heading.textContent || "";
        const match = text.match(/Claude\s+[A-Za-z0-9.]+(\s+[A-Za-z]+)?/i);
        if (match) return match[0].trim();
      }

      // Fallback: look in URL path or query string
      const url = location.href;
      if (url.includes("opus")) return "Claude Opus";
      if (url.includes("sonnet")) return "Claude Sonnet";
      if (url.includes("haiku")) return "Claude Haiku";

      // Fallback: scan all buttons for Claude model labels
      const allBtns = document.querySelectorAll("button, [role='button']");
      for (const b of allBtns) {
        const label = (b.textContent || b.getAttribute("aria-label") || "").trim();
        if (/claude\s+(opus|sonnet|haiku|3|4)/i.test(label)) {
          return label.replace(/\s+/g, " ").trim();
        }
      }

      return "Claude";
    }

    /**
     * @param {string} raw
     * @returns {string}
     */
    _normalizeModelName(raw) {
      return raw
        .replace(/^Switch to\s+/i, "")
        .replace(/^Using\s+/i, "")
        .replace(/\(.*\)/, "")
        .replace(/[\u25bc\u25b2].*$/, "") // arrow characters
        .trim();
    }

    // -----------------------------------------------------------------------
    // Status detection
    // -----------------------------------------------------------------------

    detectStatus() {
      // Tool use highest priority
      if (this._hasToolUse()) return "tool_use";

      // Check stop button (authoritative: Claude shows this while streaming)
      const stopBtn = queryFirst(SEL_STOP_BUTTON);
      if (stopBtn && isVisible(stopBtn)) {
        this._wasStreaming = true;
        clearTimeout(this._taskCompleteTimer);

        // Distinguish thinking vs responding by whether a response container exists
        const streamingEl = queryFirst(SEL_STREAMING_RESPONSE);
        if (streamingEl && isVisible(streamingEl) && (streamingEl.textContent || "").trim().length > 5) {
          return "responding";
        }

        const thinkingEl = queryFirst(SEL_THINKING);
        if (thinkingEl && isVisible(thinkingEl)) {
          return "thinking";
        }

        // Stop button visible but no specific indicator — default to responding
        return "responding";
      }

      // Check for thinking indicator without stop button (edge case during init)
      const thinkingEl = queryFirst(SEL_THINKING);
      if (thinkingEl && isVisible(thinkingEl)) {
        this._wasStreaming = true;
        clearTimeout(this._taskCompleteTimer);
        return "thinking";
      }

      // Text-based fallback for thinking state
      const bodyText = document.body.innerText || "";
      if (
        bodyText.includes("Claude is thinking") ||
        bodyText.includes("Thinking...")
      ) {
        this._wasStreaming = true;
        clearTimeout(this._taskCompleteTimer);
        return "thinking";
      }

      // Streaming just ended
      if (this._wasStreaming) {
        this._wasStreaming = false;
        this._scheduleIdleTransition();
        return "task_complete";
      }

      return "idle";
    }

    /**
     * @returns {boolean}
     */
    _hasToolUse() {
      const el = queryFirst(SEL_TOOL_INDICATORS);
      if (!el) return false;
      if (!isVisible(el)) return false;

      // For artifacts: only flag tool_use if artifact panel is actively rendering
      // (not just an existing static artifact)
      const hasActiveContent = (el.textContent || "").trim().length > 0;
      return hasActiveContent;
    }

    _scheduleIdleTransition() {
      clearTimeout(this._taskCompleteTimer);
      this._taskCompleteTimer = setTimeout(() => {
        if (!this._destroyed) {
          this.lastStatus = "";
          this._onMutation();
        }
      }, 3000);
    }

    // -----------------------------------------------------------------------
    // Observation target — main conversation area
    // -----------------------------------------------------------------------

    getObservationTarget() {
      return (
        document.querySelector("main") ||
        document.querySelector('[data-testid="conversation"]') ||
        document.querySelector(".conversation-container") ||
        document.querySelector('[role="main"]') ||
        document.body
      );
    }

    getObservationConfig() {
      return {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "data-is-streaming", "aria-hidden", "aria-label", "data-testid"],
      };
    }

    stop() {
      clearTimeout(this._taskCompleteTimer);
      super.stop();
    }
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  let observer = null;

  function init() {
    if (observer) observer.stop();
    observer = new ClaudeObserver();
    observer.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // SPA navigation detection for Claude's React router
  let lastHref = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(init, 800);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: false });

  window.addEventListener("pagehide", () => {
    if (observer) observer.stop();
    navObserver.disconnect();
  });
})();
