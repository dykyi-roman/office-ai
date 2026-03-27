/**
 * ChatGPT DOM observer for chatgpt.com.
 *
 * Detects agent status and model via MutationObserver watching the
 * conversation container. Uses resilient CSS selectors with fallbacks.
 *
 * Status detection logic:
 * - thinking:   streaming indicator (stop-button visible, no assistant text yet)
 * - responding: assistant message container actively growing with streamed text
 * - tool_use:   code interpreter / browsing / DALL-E tool indicators present
 * - idle:       no active streaming detected
 * - task_complete: briefly after streaming ends (handled via timer)
 */

(function () {
  "use strict";

  const { BaseObserver } = window.__aiOfficeBase;

  // -------------------------------------------------------------------------
  // CSS selectors — ordered from most-specific to broadest fallback
  // -------------------------------------------------------------------------

  /** Stop/abort button rendered while GPT is streaming */
  const SEL_STOP_BUTTON = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label*="Stop"]',
  ];

  /** Streaming indicator dots or "ChatGPT is typing" text */
  const SEL_TYPING_INDICATOR = [
    '[data-testid="typing-indicator"]',
    ".result-streaming",
    ".loading-dots",
  ];

  /** Assistant message containers */
  const SEL_ASSISTANT_MSG = [
    '[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"] .agent-turn',
    ".agent-turn",
  ];

  /** Model selector button showing the current model name */
  const SEL_MODEL_SELECTOR = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label="Switch model"]',
    "#model-switcher-dropdown button",
    'button[id*="radix"][aria-haspopup="menu"]',
    ".model-selector-dropdown button",
    'nav button[aria-label*="GPT"]',
  ];

  /** Tool-use indicators for code interpreter, browsing, DALL-E */
  const SEL_TOOL_INDICATORS = [
    '[data-testid="code-interpreter-running"]',
    ".tool-use-indicator",
    '[class*="toolUse"]',
    ".result-running",
    '[data-testid*="dalle"]',
    '[aria-label*="Browsing"]',
    '[aria-label*="Running"]',
  ];

  // -------------------------------------------------------------------------
  // Utility: query first matching element from a list of selectors
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
      } catch (_) {
        // Invalid selector — skip
      }
    }
    return null;
  }

  /**
   * @param {string[]} selectors
   * @param {Document | Element} [root=document]
   * @returns {NodeList | null}
   */
  function queryAll(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const list = root.querySelectorAll(sel);
        if (list.length) return list;
      } catch (_) {
        // Invalid selector — skip
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // ChatGPT-specific observer
  // -------------------------------------------------------------------------

  class ChatGPTObserver extends BaseObserver {
    constructor() {
      super("chatgpt", "ChatGPT");

      /** Timer ID for transitioning from task_complete back to idle */
      this._taskCompleteTimer = null;

      /** Whether we detected completion on last tick */
      this._wasStreaming = false;
    }

    // -----------------------------------------------------------------------
    // Model detection
    // -----------------------------------------------------------------------

    detectModel() {
      // Try model selector button text first
      const btn = queryFirst(SEL_MODEL_SELECTOR);
      if (btn) {
        const text = (btn.textContent || btn.getAttribute("aria-label") || "").trim();
        if (text) return this._normalizeModelName(text);
      }

      // Fallback: scan page title
      const title = document.title || "";
      if (title.toLowerCase().includes("gpt-4")) return "GPT-4";
      if (title.toLowerCase().includes("gpt-3.5")) return "GPT-3.5";

      // Fallback: look for model name in meta tags
      const meta = document.querySelector('meta[name="description"]');
      if (meta) {
        const content = meta.getAttribute("content") || "";
        const match = content.match(/GPT-[0-9a-z.-]+/i);
        if (match) return match[0];
      }

      return "GPT";
    }

    /**
     * Normalizes model name from UI labels.
     * @param {string} raw
     * @returns {string}
     */
    _normalizeModelName(raw) {
      // Strip extra UI chrome like "Model: ", trailing arrows, etc.
      return raw
        .replace(/^Model:\s*/i, "")
        .replace(/[\u25bc\u25b2\u2304\u2303].*$/, "") // arrow characters
        .replace(/\(.*\)/, "")                         // parenthetical notes
        .trim();
    }

    // -----------------------------------------------------------------------
    // Status detection
    // -----------------------------------------------------------------------

    detectStatus() {
      // Tool use takes highest priority
      if (this._hasToolUse()) return "tool_use";

      // Check if stop button is visible (stream in progress)
      const stopBtn = queryFirst(SEL_STOP_BUTTON);
      const isStreaming = stopBtn !== null && this._isVisible(stopBtn);

      if (isStreaming) {
        const hasAssistantContent = this._hasAssistantContent();
        this._wasStreaming = true;
        clearTimeout(this._taskCompleteTimer);
        return hasAssistantContent ? "responding" : "thinking";
      }

      // Check for typing indicator even without stop button
      const typingEl = queryFirst(SEL_TYPING_INDICATOR);
      if (typingEl && this._isVisible(typingEl)) {
        this._wasStreaming = true;
        return "thinking";
      }

      // Streaming just ended — briefly emit task_complete
      if (this._wasStreaming) {
        this._wasStreaming = false;
        this._scheduleIdleTransition();
        return "task_complete";
      }

      return "idle";
    }

    /**
     * Returns true if at least one assistant message with non-empty text exists.
     * @returns {boolean}
     */
    _hasAssistantContent() {
      const msgs = queryAll(SEL_ASSISTANT_MSG);
      if (!msgs) return false;
      for (const msg of msgs) {
        if ((msg.textContent || "").trim().length > 5) return true;
      }
      return false;
    }

    /**
     * Returns true if a tool-use indicator element is visible in DOM.
     * @returns {boolean}
     */
    _hasToolUse() {
      const el = queryFirst(SEL_TOOL_INDICATORS);
      return el !== null && this._isVisible(el);
    }

    /**
     * Checks if an element is visible (not hidden by CSS).
     * @param {Element} el
     * @returns {boolean}
     */
    _isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }

    /**
     * After streaming ends, wait 3s then transition to idle.
     */
    _scheduleIdleTransition() {
      clearTimeout(this._taskCompleteTimer);
      this._taskCompleteTimer = setTimeout(() => {
        if (!this._destroyed) {
          this.lastStatus = ""; // Force re-emit
          this._onMutation();
        }
      }, 3000);
    }

    // -----------------------------------------------------------------------
    // Observation target — main conversation wrapper
    // -----------------------------------------------------------------------

    getObservationTarget() {
      return (
        document.querySelector("main") ||
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
        attributeFilter: ["class", "aria-hidden", "data-testid", "aria-label"],
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
    if (observer) {
      observer.stop();
    }
    observer = new ChatGPTObserver();
    observer.start();
  }

  // Start immediately or wait for DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Handle SPA navigation — ChatGPT uses history.pushState
  let lastHref = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      // Give React a moment to render the new route
      setTimeout(init, 800);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: false });

  // Cleanup on page unload
  window.addEventListener("pagehide", () => {
    if (observer) observer.stop();
    navObserver.disconnect();
  });
})();
