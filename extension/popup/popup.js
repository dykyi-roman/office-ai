/**
 * Popup UI controller for the OfficeAI extension.
 *
 * Responsibilities:
 * - Connect to the background service worker via a long-lived port
 * - Display real-time connection status
 * - Render the list of detected AI agents with platform, model, status
 * - Handle "Reconnect" button
 * - Show/hide empty state based on agent count
 */

"use strict";

// ============================================================================
// DOM element references
// ============================================================================

const statusDot   = /** @type {HTMLElement} */ (document.getElementById("status-dot"));
const statusLabel = /** @type {HTMLElement} */ (document.getElementById("status-label"));
const agentList   = /** @type {HTMLUListElement} */ (document.getElementById("agent-list"));
const agentCount  = /** @type {HTMLElement} */ (document.getElementById("agent-count"));
const emptyState  = /** @type {HTMLElement} */ (document.getElementById("empty-state"));
const reconnectBtn = /** @type {HTMLButtonElement} */ (document.getElementById("reconnect-btn"));

// ============================================================================
// State
// ============================================================================

/**
 * @typedef {Object} AgentState
 * @property {string} id
 * @property {string} name
 * @property {string} model
 * @property {string} tier
 * @property {string} status
 * @property {string} source
 * @property {string} lastActivity
 */

/** @type {Map<string, AgentState>} */
const agents = new Map();

/** @type {boolean} */
let connected = false;

// ============================================================================
// Background service worker connection
// ============================================================================

/** @type {chrome.runtime.Port | null} */
let backgroundPort = null;

/**
 * Connects to the background service worker via a long-lived port.
 * Handles reconnection if the background port disconnects unexpectedly.
 */
function connectToBackground() {
  try {
    backgroundPort = chrome.runtime.connect({ name: "popup" });
  } catch (err) {
    console.error("[OfficeAI Popup] Failed to connect to background:", err);
    setConnectionStatus(false);
    return;
  }

  backgroundPort.onMessage.addListener(handleBackgroundMessage);

  backgroundPort.onDisconnect.addListener(() => {
    console.debug("[OfficeAI Popup] Background port disconnected");
    backgroundPort = null;
    setConnectionStatus(false);
  });
}

/**
 * Handles incoming messages from the background service worker.
 * @param {object} message
 */
function handleBackgroundMessage(message) {
  if (!message || !message.type) return;

  switch (message.type) {
    case "status-snapshot":
      // Full state snapshot on popup open
      setConnectionStatus(message.isConnected);
      if (Array.isArray(message.agents)) {
        agents.clear();
        for (const agent of message.agents) {
          agents.set(agent.id, agent);
        }
        renderAgentList();
      }
      break;

    case "connection-changed":
      setConnectionStatus(message.isConnected);
      break;

    case "agent-updated":
      if (message.agent && message.agent.id) {
        agents.set(message.agent.id, message.agent);
        renderAgentList();
      }
      break;

    case "agent-lost":
      if (message.agentId) {
        agents.delete(message.agentId);
        renderAgentList();
      }
      break;

    default:
      console.debug("[OfficeAI Popup] Unknown message:", message.type);
  }
}

// ============================================================================
// UI rendering
// ============================================================================

/**
 * Updates the connection status indicator.
 * @param {boolean} isConnected
 */
function setConnectionStatus(isConnected) {
  connected = isConnected;

  // Update dot state
  statusDot.classList.remove("is-connected", "is-disconnected", "is-connecting");
  statusDot.classList.add(isConnected ? "is-connected" : "is-disconnected");

  statusLabel.textContent = isConnected ? "Connected" : "Disconnected";
  statusLabel.style.color = isConnected
    ? "var(--color-connected)"
    : "var(--color-disconnected)";

  reconnectBtn.disabled = isConnected;
}

/**
 * Returns the platform slug derived from an agent id or source.
 * @param {AgentState} agent
 * @returns {"chatgpt" | "gemini" | "claude" | "unknown"}
 */
function detectPlatform(agent) {
  const id = (agent.id || "").toLowerCase();
  if (id.includes("chatgpt")) return "chatgpt";
  if (id.includes("gemini"))  return "gemini";
  if (id.includes("claude"))  return "claude";
  return "unknown";
}

/**
 * Returns a human-readable label for an agent status.
 * @param {string} status
 * @returns {string}
 */
function formatStatus(status) {
  const labels = {
    idle:           "Idle",
    walking_to_desk: "Walking",
    thinking:       "Thinking",
    responding:     "Responding",
    tool_use:       "Tool use",
    collaboration:  "Collaborating",
    task_complete:  "Done",
    error:          "Error",
    offline:        "Offline",
  };
  return labels[status] || status;
}

/**
 * Returns the platform display name.
 * @param {"chatgpt" | "gemini" | "claude" | "unknown"} platform
 * @returns {string}
 */
function formatPlatformName(platform) {
  const names = {
    chatgpt: "ChatGPT",
    gemini:  "Gemini",
    claude:  "Claude",
    unknown: "Unknown",
  };
  return names[platform] || platform;
}

/**
 * Creates a DOM element for a single agent entry.
 * @param {AgentState} agent
 * @returns {HTMLLIElement}
 */
function createAgentItem(agent) {
  const platform = detectPlatform(agent);

  const li = document.createElement("li");
  li.className = "agent-item";
  li.dataset.agentId = agent.id;

  // Platform color dot
  const platformDot = document.createElement("span");
  platformDot.className = `agent-platform agent-platform--${platform}`;
  platformDot.setAttribute("aria-label", formatPlatformName(platform));
  platformDot.title = formatPlatformName(platform);

  // Agent info block
  const info = document.createElement("div");
  info.className = "agent-info";

  const name = document.createElement("div");
  name.className = "agent-name";
  name.textContent = agent.name || formatPlatformName(platform);
  name.title = agent.name;

  const model = document.createElement("div");
  model.className = "agent-model";
  model.textContent = agent.model || "Unknown model";
  model.title = agent.model;

  info.appendChild(name);
  info.appendChild(model);

  // Status badge
  const statusEl = document.createElement("div");
  statusEl.className = `agent-status agent-status--${agent.status}`;

  const statusDotEl = document.createElement("span");
  statusDotEl.className = "agent-status__dot";

  const statusText = document.createElement("span");
  statusText.textContent = formatStatus(agent.status);

  statusEl.appendChild(statusDotEl);
  statusEl.appendChild(statusText);

  li.appendChild(platformDot);
  li.appendChild(info);
  li.appendChild(statusEl);

  return li;
}

/**
 * Re-renders the full agent list from the current agents Map.
 */
function renderAgentList() {
  const agentArray = Array.from(agents.values());

  agentCount.textContent = String(agentArray.length);

  if (agentArray.length === 0) {
    agentList.innerHTML = "";
    emptyState.classList.remove("is-hidden");
    return;
  }

  emptyState.classList.add("is-hidden");

  // Diff-update: remove stale items, add/update existing ones
  const existingIds = new Set(
    Array.from(agentList.querySelectorAll(".agent-item")).map((el) => el.dataset.agentId)
  );
  const currentIds = new Set(agentArray.map((a) => a.id));

  // Remove items no longer in agents map
  for (const el of agentList.querySelectorAll(".agent-item")) {
    if (!currentIds.has(el.dataset.agentId)) {
      el.remove();
    }
  }

  // Add or update items
  for (const agent of agentArray) {
    const existingEl = agentList.querySelector(`[data-agent-id="${CSS.escape(agent.id)}"]`);
    const newEl = createAgentItem(agent);

    if (existingEl) {
      agentList.replaceChild(newEl, existingEl);
    } else {
      agentList.appendChild(newEl);
    }
  }
}

// ============================================================================
// Event handlers
// ============================================================================

reconnectBtn.addEventListener("click", () => {
  reconnectBtn.disabled = true;
  statusDot.classList.remove("is-connected", "is-disconnected");
  statusDot.classList.add("is-connecting");
  statusLabel.textContent = "Reconnecting...";

  chrome.runtime.sendMessage({ type: "popup:reconnect" }, (_response) => {
    if (chrome.runtime.lastError) {
      console.debug("[OfficeAI Popup] Reconnect message error:", chrome.runtime.lastError.message);
    }
  });
});

// ============================================================================
// Bootstrap
// ============================================================================

// Initial UI state
setConnectionStatus(false);
statusDot.classList.add("is-connecting");
statusLabel.textContent = "Connecting...";

connectToBackground();
