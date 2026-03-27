/**
 * Gemini DOM observer for gemini.google.com.
 *
 * Detects agent status and model via MutationObserver watching the
 * conversation container. Uses resilient CSS selectors with fallbacks.
 *
 * Status detection logic:
 * - thinking:   loading spinner / "Gemini is thinking..." visible
 * - responding: model-response element has loading attribute or is growing
 * - tool_use:   code execution or Google Search grounding indicators
 * - idle:       all responses fully rendered, no spinners
 * - task_complete: briefly after streaming ends (3s timeout then idle)
 */

(function () {
  "use strict";

  const { BaseObserver } = window.__aiOfficeBase;

  // -------------------------------------------------------------------------
  // CSS selectors
  // -------------------------------------------------------------------------

  /** Stop/cancel button rendered while Gemini is streaming */
  const SEL_STOP_BUTTON = [
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Cancel"]',
  ];

  /** Spinner / progress indicator shown while model is processing */
  const SEL_LOADING_SPINNER = [
    ".loading-spinner",
    'mat-progress-spinner[mode="indeterminate"]',
    "[data-loading-state]",
    ".thinking-indicator",
    ".pending-indicator",
    '[aria-label="Loading"]',
    'img[alt="Gemini is thinking"]',
  ];

  /** The "Gemini is thinking" or generating state indicators */
  const SEL_THINKING_TEXT = [
    ".thinking-placeholder",
    ".response-loading",
    ".generating-indicator",
  ];

  /** Response container currently receiving streamed tokens */
  const SEL_RESPONSE_CONTAINER = [
    "model-response",
    ".model-response",
    ".response-container",
    "message-content[role='model']",
    ".chat-turn-content",
  ];

  /** Attribute/class indicating active streaming on a response element */
  const SEL_STREAMING_RESPONSE = [
    "model-response[loading]",
    "model-response[is-generating]",
    ".response-container.loading",
    ".response-container.generating",
    "[is-generating]",
  ];

  /** Tool-use indicators: code execution, Google Search grounding, extensions */
  const SEL_TOOL_INDICATORS = [
    ".code-execution-output",
    "[data-tool-use]",
    ".google-search-grounding",
    ".tool-result",
    ".extension-response",
    '[aria-label*="code"]',
    '[aria-label*="Search"]',
    ".gemini-code-execution",
  ];

  /** Model/variant selector in the UI */
  const SEL_MODEL_SELECTOR = [
    ".model-selector-dropdown button",
    'bard-mode-switcher button',
    '[aria-label*="Gemini"] button',
    ".variant-selector",
    "model-select-dropdown",
    '[data-test-id="model-selector"]',
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
   * @param {string} text
   * @returns {boolean}
   */
  function pageContainsText(text) {
    return document.body.innerText.toLowerCase().includes(text.toLowerCase());
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
  // Gemini-specific observer
  // -------------------------------------------------------------------------

  class GeminiObserver extends BaseObserver {
    constructor() {
      super("gemini", "Gemini");
      this._wasStreaming = false;
      this._taskCompleteTimer = null;
    }

    // -----------------------------------------------------------------------
    // Model detection
    // -----------------------------------------------------------------------

    detectModel() {
      // Try model selector button
      const btn = queryFirst(SEL_MODEL_SELECTOR);
      if (btn) {
        const text = (btn.textContent || btn.getAttribute("aria-label") || "").trim();
        if (text) return this._normalizeModelName(text);
      }

      // Fallback: check page title
      const title = document.title || "";
      if (title.includes("Ultra")) return "Gemini Ultra";
      if (title.includes("Advanced")) return "Gemini Advanced";

      // Fallback: check URL — /app/bard vs /app/gemini-advanced
      const path = location.pathname;
      if (path.includes("advanced")) return "Gemini Advanced";
      if (path.includes("ultra")) return "Gemini Ultra";

      // Fallback: check input placeholder "Ask Gemini 3", "Ask Gemini 2.5 Pro", etc.
      const inputs = document.querySelectorAll('input[placeholder*="Gemini"], textarea[placeholder*="Gemini"], [contenteditable][aria-placeholder*="Gemini"], .ql-editor[data-placeholder*="Gemini"]');
      for (const el of inputs) {
        const ph = el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") || "";
        const match = ph.match(/Gemini\s+[\d.]+\s*\w*/i);
        if (match) return match[0].trim();
      }

      // Fallback: look for model name in aria labels
      const allBtns = document.querySelectorAll("button");
      for (const b of allBtns) {
        const label = (b.getAttribute("aria-label") || b.textContent || "").trim();
        if (/gemini\s+(ultra|pro|flash|nano|advanced|\d)/i.test(label)) {
          return label.match(/gemini\s+\S+/i)?.[0] || "Gemini";
        }
      }

      return "Gemini";
    }

    /**
     * @param {string} raw
     * @returns {string}
     */
    _normalizeModelName(raw) {
      return raw
        .replace(/^Switch to /i, "")
        .replace(/\(.*\)/, "")
        .trim();
    }

    // -----------------------------------------------------------------------
    // Status detection
    // -----------------------------------------------------------------------

    detectStatus() {
      // Tool use highest priority
      if (this._hasToolUse()) return "tool_use";

      // Check for stop button (most reliable indicator of active streaming)
      const stopBtn = queryFirst(SEL_STOP_BUTTON);
      if (stopBtn && isVisible(stopBtn)) {
        this._wasStreaming = true;
        clearTimeout(this._taskCompleteTimer);
        // If response content exists, it's responding; otherwise still thinking
        const hasContent = this._hasResponseContent();
        return hasContent ? "responding" : "thinking";
      }

      // Check for active streaming response element
      for (const sel of SEL_STREAMING_RESPONSE) {
        try {
          const el = document.querySelector(sel);
          if (el && isVisible(el)) {
            this._wasStreaming = true;
            clearTimeout(this._taskCompleteTimer);
            return "responding";
          }
        } catch (_) {}
      }

      // Check for thinking spinner
      const spinner = queryFirst(SEL_LOADING_SPINNER);
      if (spinner && isVisible(spinner)) {
        this._wasStreaming = true;
        clearTimeout(this._taskCompleteTimer);
        return "thinking";
      }

      // Check for thinking placeholder text
      const thinking = queryFirst(SEL_THINKING_TEXT);
      if (thinking && isVisible(thinking)) {
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
     * Checks if the last model response has non-trivial text content.
     * @returns {boolean}
     */
    _hasResponseContent() {
      const responses = document.querySelectorAll("model-response, .model-response, .response-container");
      if (responses.length === 0) return false;
      const last = responses[responses.length - 1];
      return (last.textContent || "").trim().length > 5;
    }

    /**
     * @returns {boolean}
     */
    _hasToolUse() {
      const el = queryFirst(SEL_TOOL_INDICATORS);
      return el !== null && isVisible(el);
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
    // Observation target
    // -----------------------------------------------------------------------

    getObservationTarget() {
      return (
        document.querySelector("main") ||
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
        attributeFilter: ["class", "loading", "is-generating", "aria-hidden", "aria-label"],
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
    observer = new GeminiObserver();
    observer.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // SPA navigation detection for Gemini's Angular/React router
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
