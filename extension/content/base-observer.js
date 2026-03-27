/**
 * Base observer utilities shared across all AI platform content scripts.
 *
 * Provides:
 * - BaseObserver class with MutationObserver lifecycle management
 * - Debounce utility (300ms default)
 * - Model-to-tier mapping
 * - Agent ID generation
 * - State change deduplication
 * - chrome.runtime.sendMessage wrapper with error handling
 */

/**
 * @typedef {"expert" | "senior" | "middle" | "junior"} Tier
 * @typedef {"idle" | "walking_to_desk" | "thinking" | "responding" | "tool_use" | "collaboration" | "task_complete" | "error" | "offline"} Status
 * @typedef {"browser_extension"} Source
 */

/**
 * @typedef {Object} AgentState
 * @property {string} id
 * @property {null} pid
 * @property {string} name
 * @property {string} model
 * @property {Tier} tier
 * @property {string} role
 * @property {Status} status
 * @property {"desk"} idleLocation
 * @property {string | null} currentTask
 * @property {number} tokensIn
 * @property {number} tokensOut
 * @property {Array} subAgents
 * @property {string} lastActivity
 * @property {string} startedAt
 * @property {Source} source
 */

/**
 * Maps model name keywords to their tier classification.
 * Keywords are matched case-insensitively against the full model name.
 *
 * @type {Array<{ keywords: string[], tier: Tier }>}
 */
const MODEL_TIER_RULES = [
  // Junior FIRST — "-mini" (hyphenated to avoid "gemini" false positive), haiku, nano, flash, gpt-3.5
  { keywords: ["-mini", "haiku", "nano", "flash", "gpt-3.5", "codex-spark", "instant"], tier: "junior" },
  // Expert: most capable models (checked after junior so gpt-4o-mini won't match here)
  { keywords: ["opus", "ultra", "gpt-4o", "gpt-5.4", "o1", "o3"], tier: "expert" },
  // Senior: high-capability production models
  { keywords: ["sonnet", "pro", "gpt-4", "gpt-5-codex", "gpt-5.3-codex"], tier: "senior" },
  // Middle: everything else (handled by default return in mapModelToTier)
];

/**
 * Returns the tier for a given model name string.
 * Defaults to "middle" when no keyword matches.
 *
 * @param {string} modelName
 * @returns {Tier}
 */
function mapModelToTier(modelName) {
  if (!modelName) return "middle";
  const lower = modelName.toLowerCase();
  for (const rule of MODEL_TIER_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.tier;
    }
  }
  return "middle";
}

/**
 * Generates a stable agent ID scoped to a platform and browser tab.
 * Uses chrome.runtime messaging to obtain the tab ID asynchronously,
 * but provides a synchronous fallback using document URL hash.
 *
 * @param {string} platform - e.g. "chatgpt", "gemini", "claude"
 * @returns {string}
 */
function generateAgentId(platform) {
  // Fallback: derive a stable suffix from the page origin + pathname
  const urlHash = btoa(window.location.origin + window.location.pathname).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `browser-${platform}-${urlHash}`;
}

/**
 * Creates a debounced version of fn that delays invocation by `wait` ms.
 * Each new call resets the timer.
 *
 * @param {Function} fn
 * @param {number} [wait=300]
 * @returns {Function}
 */
function debounce(fn, wait = 300) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Creates a throttled version of fn that fires immediately on first call,
 * then at most once per `wait` ms, with a trailing call after activity stops.
 * Critical for streaming detection: trailing-edge debounce misses short streams
 * because DOM mutations continuously reset the timer.
 *
 * @param {Function} fn
 * @param {number} [wait=300]
 * @returns {Function}
 */
function throttle(fn, wait = 300) {
  let last = 0;
  let timer = null;
  return function (...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn.apply(this, args);
    } else if (timer === null) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, wait - (now - last));
    }
  };
}

/**
 * Sends an AgentState message to the background service worker.
 * Silently ignores errors caused by extension context invalidation
 * (e.g., extension reload, page navigation).
 *
 * @param {AgentState} agentState
 */
function sendAgentState(agentState) {
  if (!chrome?.runtime?.id) {
    // Extension context has been invalidated; skip silently
    return;
  }
  chrome.runtime.sendMessage(
    { type: "agent:state", payload: agentState },
    // Response callback — ignored but prevents "unchecked runtime.lastError"
    (_response) => {
      if (chrome.runtime.lastError) {
        // Context invalidated or background not ready; log and continue
        console.debug("[AI Office] sendAgentState error:", chrome.runtime.lastError.message);
      }
    }
  );
}

/**
 * Abstract base class for AI platform DOM observers.
 *
 * Subclasses must implement:
 *   - detectModel()  -> string
 *   - detectStatus() -> Status
 *   - getObservationTarget() -> Element | null
 *   - getObservationConfig() -> MutationObserverInit
 *
 * Optional overrides:
 *   - buildCurrentTask(status) -> string | null
 */
class BaseObserver {
  /**
   * @param {string} platform - Short platform slug: "chatgpt" | "gemini" | "claude"
   * @param {string} agentName - Human-readable name for the agent
   */
  constructor(platform, agentName) {
    this.platform = platform;
    this.agentName = agentName;
    this.agentId = generateAgentId(platform);

    /** @type {Status} */
    this.lastStatus = "idle";
    this.lastModel = "";

    /** @type {MutationObserver | null} */
    this._observer = null;

    /** @type {ReturnType<typeof throttle>} */
    this._throttledUpdate = throttle(this._onMutation.bind(this), 300);

    this._destroyed = false;
    this.startedAt = new Date().toISOString();
  }

  /**
   * Detects the current model name from the page UI.
   * @returns {string}
   */
  detectModel() {
    return "unknown";
  }

  /**
   * Detects the current agent status from the DOM.
   * @returns {Status}
   */
  detectStatus() {
    return "idle";
  }

  /**
   * Returns the DOM element to observe for mutations.
   * @returns {Element | null}
   */
  getObservationTarget() {
    return document.body;
  }

  /**
   * Returns the MutationObserver init options.
   * @returns {MutationObserverInit}
   */
  getObservationConfig() {
    return { childList: true, subtree: true, characterData: true, attributes: true };
  }

  /**
   * Builds a human-readable current task string based on status.
   * @param {Status} status
   * @returns {string | null}
   */
  buildCurrentTask(status) {
    switch (status) {
      case "thinking": return "Processing prompt";
      case "responding": return "Generating response";
      case "tool_use": return "Using tool";
      case "task_complete": return "Task complete";
      default: return null;
    }
  }

  /**
   * Starts the MutationObserver. Waits for observation target with retries.
   */
  start() {
    if (this._destroyed) return;

    const target = this.getObservationTarget();
    if (!target) {
      // Target not in DOM yet — retry after 1s
      setTimeout(() => this.start(), 1000);
      return;
    }

    this._observer = new MutationObserver(this._throttledUpdate);
    this._observer.observe(target, this.getObservationConfig());

    // Emit initial state
    this._onMutation();

    console.debug(`[AI Office] ${this.platform} observer started`);
  }

  /**
   * Stops the observer and cleans up resources.
   */
  stop() {
    this._destroyed = true;
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    console.debug(`[AI Office] ${this.platform} observer stopped`);
  }

  /**
   * Called on each debounced mutation batch.
   * Detects model and status, then sends state if changed.
   */
  _onMutation() {
    if (this._destroyed) return;

    let model, status;
    try {
      model = this.detectModel() || "unknown";
      status = this.detectStatus() || "idle";
    } catch (err) {
      console.error(`[AI Office] ${this.platform} detection error:`, err);
      return;
    }

    // Only emit when state actually changes
    if (status === this.lastStatus && model === this.lastModel) return;

    this.lastStatus = status;
    this.lastModel = model;

    /** @type {AgentState} */
    const agentState = {
      id: this.agentId,
      pid: null,
      name: this.agentName,
      model,
      tier: mapModelToTier(model),
      role: "agent",
      status,
      idleLocation: "desk",
      currentTask: this.buildCurrentTask(status),
      tokensIn: 0,
      tokensOut: 0,
      subAgents: [],
      lastActivity: new Date().toISOString(),
      startedAt: this.startedAt,
      source: "browser_extension",
    };

    sendAgentState(agentState);
  }
}

// Expose utilities for use by platform-specific observer scripts
window.__aiOfficeBase = {
  BaseObserver,
  mapModelToTier,
  generateAgentId,
  debounce,
  throttle,
  sendAgentState,
};
