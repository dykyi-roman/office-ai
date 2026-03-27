/**
 * Background service worker for the OfficeAI Chrome extension.
 *
 * Responsibilities:
 * - Receive AgentState messages from content scripts
 * - Forward them to the Tauri desktop app via Chrome Native Messaging
 * - Manage native messaging connection lifecycle with exponential backoff reconnect
 * - Track active agents per tab; emit agent:lost when tabs close
 * - Expose connection status and agent registry to the popup UI
 * - Send periodic heartbeat every 5s to verify native host connection
 */

"use strict";

// ============================================================================
// Constants
// ============================================================================

const NATIVE_HOST_NAME = "office_ai";
const HEARTBEAT_INTERVAL_MS = 5000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MULTIPLIER = 2;

// ============================================================================
// State
// ============================================================================

/**
 * Current native messaging port (null when disconnected).
 * @type {chrome.runtime.Port | null}
 */
let nativePort = null;

/**
 * Whether the native host is currently connected.
 * @type {boolean}
 */
let isConnected = false;

/**
 * Reconnect attempt counter for exponential backoff.
 * @type {number}
 */
let reconnectAttempts = 0;

/**
 * Timer ID for the scheduled reconnect attempt.
 * @type {ReturnType<typeof setTimeout> | null}
 */
let reconnectTimer = null;

/**
 * Timer ID for the periodic heartbeat.
 * @type {ReturnType<typeof setInterval> | null}
 */
let heartbeatTimer = null;

/**
 * Map from tabId -> AgentState for all currently active browser agents.
 * @type {Map<number, import('./content/base-observer.js').AgentState>}
 */
const activeAgents = new Map();

// ============================================================================
// Native Messaging connection management
// ============================================================================

/**
 * Establishes a new connection to the native messaging host.
 * Sets up message and disconnect listeners.
 */
function connectNative() {
  if (nativePort) {
    // Already connected or connecting
    return;
  }

  console.log("[OfficeAI BG] Connecting to native host:", NATIVE_HOST_NAME);

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    console.error("[OfficeAI BG] connectNative failed:", err);
    scheduleReconnect();
    return;
  }

  nativePort.onMessage.addListener(onNativeMessage);
  nativePort.onDisconnect.addListener(onNativeDisconnect);

  isConnected = true;
  reconnectAttempts = 0;
  reconnectTimer = null;

  startHeartbeat();
  notifyPopupConnectionChange();

  console.log("[OfficeAI BG] Native host connected");
}

/**
 * Handles messages received from the native host (Tauri app).
 * @param {unknown} message
 */
function onNativeMessage(message) {
  console.debug("[OfficeAI BG] Native message received:", message);
  // Reserved for future bidirectional commands from the Tauri side
}

/**
 * Handles native host disconnection.
 * Cleans up state and schedules a reconnect attempt.
 */
function onNativeDisconnect() {
  const error = chrome.runtime.lastError;
  if (error) {
    console.warn("[OfficeAI BG] Native host disconnected:", error.message);
  } else {
    console.log("[OfficeAI BG] Native host disconnected");
  }

  nativePort = null;
  isConnected = false;

  stopHeartbeat();
  notifyPopupConnectionChange();
  scheduleReconnect();
}

/**
 * Schedules the next reconnect attempt with exponential backoff.
 */
function scheduleReconnect() {
  if (reconnectTimer !== null) return;

  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempts),
    RECONNECT_MAX_DELAY_MS
  );
  reconnectAttempts++;

  console.log(`[OfficeAI BG] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, delay);
}

/**
 * Sends a message to the native host.
 * If the port is not connected, the message is silently dropped.
 * @param {object} message
 */
function sendToNative(message) {
  if (!nativePort || !isConnected) {
    console.debug("[OfficeAI BG] Drop message (not connected):", message?.type);
    return;
  }
  try {
    nativePort.postMessage(message);
  } catch (err) {
    console.error("[OfficeAI BG] postMessage failed:", err);
    // Port may be broken — force disconnect handling
    onNativeDisconnect();
  }
}

// ============================================================================
// Heartbeat
// ============================================================================

/**
 * Starts the periodic heartbeat. Sends a ping every 5s to detect stale connections.
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    sendToNative({ type: "heartbeat", timestamp: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stops the periodic heartbeat timer.
 */
function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ============================================================================
// Message handling from content scripts
// ============================================================================

/**
 * Processes an AgentState update from a content script.
 * Registers the agent, forwards state to native host.
 *
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 */
function handleAgentState(message, sender) {
  const agentState = message.payload;
  if (!agentState || !agentState.id) {
    console.warn("[OfficeAI BG] Invalid agent:state payload");
    return;
  }

  const tabId = sender.tab?.id;
  if (tabId !== undefined) {
    activeAgents.set(tabId, agentState);
  }

  // Forward to Tauri native host
  sendToNative({ type: "agent:state", payload: agentState });

  // Notify popup if open
  notifyPopupAgentUpdate(agentState);
}

/**
 * Emits agent:lost for all agents registered under the given tab.
 * @param {number} tabId
 */
function handleTabClosed(tabId) {
  const agentState = activeAgents.get(tabId);
  if (!agentState) return;

  console.log(`[OfficeAI BG] Tab ${tabId} closed, removing agent: ${agentState.id}`);

  sendToNative({ type: "agent:lost", payload: { id: agentState.id } });
  activeAgents.delete(tabId);
  notifyPopupAgentLost(agentState.id);
}

// ============================================================================
// Chrome Extension event listeners
// ============================================================================

// Content script messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case "agent:state":
      handleAgentState(message, sender);
      sendResponse({ ok: true });
      break;

    case "popup:get-status":
      // Popup requesting current state
      sendResponse({
        isConnected,
        agents: Array.from(activeAgents.values()),
      });
      break;

    case "popup:reconnect":
      // Popup user clicked "Reconnect"
      if (!isConnected) {
        reconnectAttempts = 0;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connectNative();
      }
      sendResponse({ ok: true });
      break;

    default:
      console.debug("[OfficeAI BG] Unknown message type:", message.type);
  }

  return false; // No async sendResponse needed
});

// Tab close event — clean up agent entries
chrome.tabs.onRemoved.addListener((tabId, _removeInfo) => {
  handleTabClosed(tabId);
});

// Tab navigation (content script will re-init, but we clean old state)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
  if (changeInfo.status === "loading") {
    // Navigation started — remove stale agent state; new state will arrive on load
    if (activeAgents.has(tabId)) {
      const agentState = activeAgents.get(tabId);
      activeAgents.delete(tabId);
      sendToNative({ type: "agent:lost", payload: { id: agentState.id } });
      notifyPopupAgentLost(agentState.id);
    }
  }
});

// ============================================================================
// Popup communication (long-lived port for live updates)
// ============================================================================

/** @type {Set<chrome.runtime.Port>} */
const popupPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;

  popupPorts.add(port);

  // Send immediate status snapshot to the newly opened popup
  port.postMessage({
    type: "status-snapshot",
    isConnected,
    agents: Array.from(activeAgents.values()),
  });

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});

/**
 * Broadcasts connection status change to all open popups.
 */
function notifyPopupConnectionChange() {
  const msg = { type: "connection-changed", isConnected };
  for (const port of popupPorts) {
    try { port.postMessage(msg); } catch (_) { popupPorts.delete(port); }
  }
}

/**
 * Broadcasts agent state update to all open popups.
 * @param {object} agentState
 */
function notifyPopupAgentUpdate(agentState) {
  const msg = { type: "agent-updated", agent: agentState };
  for (const port of popupPorts) {
    try { port.postMessage(msg); } catch (_) { popupPorts.delete(port); }
  }
}

/**
 * Broadcasts agent removal to all open popups.
 * @param {string} agentId
 */
function notifyPopupAgentLost(agentId) {
  const msg = { type: "agent-lost", agentId };
  for (const port of popupPorts) {
    try { port.postMessage(msg); } catch (_) { popupPorts.delete(port); }
  }
}

// ============================================================================
// Service worker lifecycle
// ============================================================================

// Service workers can be suspended; re-establish connection when woken up
self.addEventListener("activate", () => {
  console.log("[OfficeAI BG] Service worker activated");
  connectNative();
});

// Initial connection on install / first load
connectNative();
