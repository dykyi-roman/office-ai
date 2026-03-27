#!/usr/bin/env node
/**
 * Native Messaging Host for the OfficeAI Chrome extension.
 *
 * Protocol: Chrome Native Messaging — 4-byte little-endian length prefix + JSON body.
 * Transport: stdin/stdout (stdio type in host manifest).
 *
 * This host bridges the Chrome extension to the Tauri desktop application.
 * It reads AgentState messages from the extension and forwards them to Tauri
 * via HTTP POST to localhost:7842 (configurable via OFFICE_AI_PORT env var).
 *
 * If the Tauri app is not running, messages are queued (up to MAX_QUEUE_SIZE)
 * and flushed on the next successful delivery.
 */

"use strict";

const http = require("http");

// ============================================================================
// Configuration
// ============================================================================

const TAURI_HOST = "127.0.0.1";
const TAURI_PORT = parseInt(process.env.OFFICE_AI_PORT || "7842", 10);
const TAURI_PATH = "/extension";
const MAX_QUEUE_SIZE = 100;
const FLUSH_RETRY_INTERVAL_MS = 2000;

// ============================================================================
// Message queue for offline Tauri app
// ============================================================================

/** @type {object[]} */
const pendingQueue = [];
let flushRetryTimer = null;

// ============================================================================
// Chrome Native Messaging I/O
// ============================================================================

/**
 * Reads a single Chrome native messaging message from stdin.
 * Chrome writes: [4-byte LE length][JSON bytes]
 *
 * @param {(message: object) => void} onMessage
 */
function readNativeMessage(onMessage) {
  // Buffer accumulator for incoming data
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Process all complete messages in the buffer
    while (buffer.length >= 4) {
      const msgLength = buffer.readUInt32LE(0);

      // Guard against corrupt messages (>10MB)
      if (msgLength > 10 * 1024 * 1024) {
        process.stderr.write("[OfficeAI Host] Corrupt message length, exiting\n");
        process.exit(1);
      }

      if (buffer.length < 4 + msgLength) {
        // Incomplete — wait for more data
        break;
      }

      const jsonBytes = buffer.slice(4, 4 + msgLength);
      buffer = buffer.slice(4 + msgLength);

      let message;
      try {
        message = JSON.parse(jsonBytes.toString("utf8"));
      } catch (err) {
        process.stderr.write(`[OfficeAI Host] JSON parse error: ${err.message}\n`);
        continue;
      }

      onMessage(message);
    }
  });

  process.stdin.on("end", () => {
    process.stderr.write("[OfficeAI Host] stdin closed, shutting down\n");
    process.exit(0);
  });

  process.stdin.on("error", (err) => {
    process.stderr.write(`[OfficeAI Host] stdin error: ${err.message}\n`);
    process.exit(1);
  });
}

/**
 * Writes a Chrome native messaging response to stdout.
 * @param {object} message
 */
function writeNativeMessage(message) {
  let json;
  try {
    json = JSON.stringify(message);
  } catch (err) {
    process.stderr.write(`[OfficeAI Host] JSON stringify error: ${err.message}\n`);
    return;
  }

  const jsonBuffer = Buffer.from(json, "utf8");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(jsonBuffer.length, 0);

  try {
    process.stdout.write(Buffer.concat([lengthBuffer, jsonBuffer]));
  } catch (err) {
    process.stderr.write(`[OfficeAI Host] stdout write error: ${err.message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// Tauri HTTP bridge
// ============================================================================

/**
 * Posts a message to the Tauri app via HTTP.
 * Queues the message if the request fails.
 *
 * @param {object} message
 */
function forwardToTauri(message) {
  const body = JSON.stringify(message);

  const options = {
    hostname: TAURI_HOST,
    port: TAURI_PORT,
    path: TAURI_PATH,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body, "utf8"),
      "X-Source": "chrome-extension",
    },
  };

  const req = http.request(options, (res) => {
    // Drain response body to free socket
    res.resume();
    if (res.statusCode !== 200) {
      process.stderr.write(`[OfficeAI Host] Tauri returned HTTP ${res.statusCode}\n`);
    }
  });

  req.on("error", (err) => {
    process.stderr.write(`[OfficeAI Host] Tauri unreachable: ${err.message}\n`);
    enqueue(message);
    scheduleFlushRetry();
  });

  req.setTimeout(3000, () => {
    process.stderr.write("[OfficeAI Host] Tauri request timed out\n");
    req.destroy();
    enqueue(message);
    scheduleFlushRetry();
  });

  req.write(body, "utf8");
  req.end();
}

/**
 * Adds a message to the pending queue (dropping oldest if full).
 * @param {object} message
 */
function enqueue(message) {
  if (pendingQueue.length >= MAX_QUEUE_SIZE) {
    pendingQueue.shift(); // Drop oldest
  }
  pendingQueue.push(message);
}

/**
 * Schedules a retry flush of the pending queue.
 */
function scheduleFlushRetry() {
  if (flushRetryTimer) return;
  flushRetryTimer = setTimeout(flushQueue, FLUSH_RETRY_INTERVAL_MS);
}

/**
 * Attempts to flush all pending messages to Tauri.
 */
function flushQueue() {
  flushRetryTimer = null;
  if (pendingQueue.length === 0) return;

  const messages = pendingQueue.splice(0, pendingQueue.length);
  process.stderr.write(`[OfficeAI Host] Flushing ${messages.length} queued messages\n`);

  for (const msg of messages) {
    forwardToTauri(msg);
  }
}

// ============================================================================
// Message dispatcher
// ============================================================================

/**
 * Dispatches an incoming message from the Chrome extension.
 * @param {object} message
 */
function dispatch(message) {
  if (!message || !message.type) {
    process.stderr.write("[OfficeAI Host] Received message without type\n");
    return;
  }

  switch (message.type) {
    case "agent:state":
      forwardToTauri(message);
      break;

    case "agent:lost":
      forwardToTauri(message);
      break;

    case "heartbeat":
      // Echo heartbeat back to confirm host is alive
      writeNativeMessage({ type: "heartbeat:ack", timestamp: message.timestamp });
      break;

    default:
      process.stderr.write(`[OfficeAI Host] Unknown message type: ${message.type}\n`);
  }
}

// ============================================================================
// Bootstrap
// ============================================================================

process.stderr.write(
  `[OfficeAI Host] Starting, Tauri endpoint: http://${TAURI_HOST}:${TAURI_PORT}${TAURI_PATH}\n`
);

readNativeMessage(dispatch);

// Graceful shutdown signals
process.on("SIGTERM", () => {
  process.stderr.write("[OfficeAI Host] SIGTERM received, exiting\n");
  process.exit(0);
});

process.on("SIGINT", () => {
  process.stderr.write("[OfficeAI Host] SIGINT received, exiting\n");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[OfficeAI Host] Uncaught exception: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
