# Chrome Extension — OfficeAI

> Chrome MV3 extension documentation for monitoring browser-based AI agents. For detailed architecture see [ARCHITECTURE.md](./ARCHITECTURE.md) § 5.

## Table of Contents

1. [Overview](#1-overview)
2. [Supported Platforms](#2-supported-platforms)
3. [Architecture](#3-architecture)
4. [Data Flow](#4-data-flow)
5. [Installation](#5-installation)
6. [Native Messaging Host](#6-native-messaging-host)
7. [Popup UI](#7-popup-ui)
8. [Detection Algorithms](#8-detection-algorithms)
9. [Tauri HTTP Server](#9-tauri-http-server-backend)

---

## 1. Overview

OfficeAI Chrome Extension is an MV3 extension that monitors AI agent activity in browser chats and transmits their state to the OfficeAI desktop application. It operates on a zero-intrusion principle: it only observes the DOM via `MutationObserver` without modifying pages.

**Technology:** Vanilla JavaScript (no build step, no dependencies)

**Location:** `extension/`

---

## 2. Supported Platforms

| Platform | URL | Content Script |
|---|---|---|
| **ChatGPT** | `chatgpt.com` | `observer-chatgpt.js` |
| **Gemini** | `gemini.google.com` | `observer-gemini.js` |
| **Claude** | `claude.ai` | `observer-claude.js` |

Each content script extends `BaseObserver` (`base-observer.js`) and implements platform-specific detection methods.

---

## 3. Architecture

```
extension/
├── manifest.json                    — MV3 manifest
├── background.js                    — Service Worker (bridge to native host)
├── content/
│   ├── base-observer.js             — Base class (MutationObserver, debounce)
│   ├── observer-chatgpt.js          — ChatGPT detector
│   ├── observer-gemini.js           — Gemini detector
│   └── observer-claude.js           — Claude.ai detector
├── popup/
│   ├── popup.html                   — Popup UI (300×400px)
│   ├── popup.css                    — Styles
│   └── popup.js                     — Popup logic
├── native-messaging/
│   ├── host.js                      — Node.js Native Messaging Host
│   ├── office_ai.json               — Host manifest (template)
│   └── install.sh                   — Installation script
└── icons/
    ├── icon-48.png
    └── icon-128.png
```

### Permissions

```json
{
  "permissions": ["nativeMessaging", "activeTab", "tabs"],
  "host_permissions": [
    "*://chatgpt.com/*",
    "*://gemini.google.com/*",
    "*://claude.ai/*"
  ]
}
```

---

## 4. Data Flow

```
┌──────────────────┐     chrome.runtime.sendMessage()
│  Content Script   │ ──────────────────────────────────►
│  (MutationObserver)│                                    │
└──────────────────┘                                    │
                                                         ▼
                                              ┌──────────────────────┐
                                              │ Background Service   │
                                              │ Worker               │
                                              └──────────┬───────────┘
                                                         │
                                     chrome.runtime.connectNative("office_ai")
                                                         │
                                                         ▼
                                              ┌──────────────────────┐
                                              │ Native Messaging Host│
                                              │ (Node.js, stdio)     │
                                              └──────────┬───────────┘
                                                         │
                                              HTTP POST localhost:7842/extension
                                                         │
                                                         ▼
                                              ┌──────────────────────┐
                                              │ Tauri Desktop App    │
                                              └──────────────────────┘
```

### Native Messaging Protocol

Chrome Native Messaging uses stdio with binary framing:

```
┌──────────────────────────────┐
│ 4 bytes (uint32 LE) │ JSON  │
│   JSON body length  │ body  │
└──────────────────────────────┘
```

### Reconnection

Background Service Worker implements reconnection with exponential backoff:

```
delay = min(1000 × 2^attempts, 30000)
```

Heartbeat `{ type: "heartbeat", timestamp }` is sent every 5s.

---

## 5. Installation

### 1. Load Extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` directory
5. Copy the **Extension ID** (32-character string)

### 2. Install Native Messaging Host

```bash
cd extension/native-messaging
./install.sh <extension-id>
```

The script automatically:
- Checks for Node.js availability
- Creates the `office-ai-host` wrapper script
- Generates the `office_ai.json` manifest with correct paths and extension ID
- Installs the manifest for Chrome and Chromium

**Supported OS:**

| OS | Chrome Directory |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/` |
| Windows | Registry: `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\office_ai` |

### 3. Build zip for Distribution

To install the extension without Developer mode or publish to Chrome Web Store:

```bash
cd extension && zip -r ../office-ai-extension.zip . \
  -x ".*" \
  -x "native-messaging/.gitkeep" \
  -x "content/.gitkeep" \
  -x "popup/.gitkeep" \
  -x "icons/generate-icons.js"
```

Result — `office-ai-extension.zip` file in the project root.

**Installation options:**

| Method | Description |
|---|---|
| Chrome Web Store | Upload zip to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) (developer account, $5 one-time fee) |
| Manual installation | Drag `.zip` onto `chrome://extensions/` page (Developer mode must be enabled) |

> **Note:** Native Messaging Host is installed separately (see step 2) — it is not included in the zip and requires OS-level registration.

### 4. Verification

Open Chrome → `chrome://extensions` → OfficeAI → Details → Native Messaging

Or test manually:
```bash
echo '{}' | extension/native-messaging/office-ai-host
```

---

## 6. Native Messaging Host

**File:** `extension/native-messaging/host.js`

Node.js process connected to Chrome via stdio. Performs two functions:

1. **Receiving messages** from Chrome Extension (stdin) → parsing 4-byte header + JSON
2. **HTTP bridge to Tauri** — forwarding via `POST http://127.0.0.1:7842/extension`

### Offline Message Queue

When Tauri is unavailable, messages are buffered (up to 100). On overflow — oldest messages are discarded. Retry every 2 seconds.

### HTTP Request to Tauri

```
POST http://127.0.0.1:7842/extension
Content-Type: application/json
X-Source: chrome-extension
Body: JSON
Timeout: 3s
```

---

## 7. Popup UI

Minimalist popup (300×400px):

- **Connection status** — green/red dot + text (Connected/Disconnected)
- **Agent list** — platform colors (ChatGPT=green, Gemini=blue, Claude=orange)
- **Status badges** — current state of each agent
- **Reconnect button** — reconnect to Tauri via Native Messaging
- **Version** — current extension version

---

## 8. Detection Algorithms

### Base Class (BaseObserver)

Subclasses implement 4 methods:

| Method                   | Description                              |
|--------------------------|------------------------------------------|
| `detectModel()`          | Extract model name from DOM              |
| `detectStatus()`         | Determine current status                 |
| `getObservationTarget()` | Target DOM element for MutationObserver  |
| `getObservationConfig()` | MutationObserver configuration           |

**Debounce:** 300ms for batching DOM changes.

**Deduplication:** sends only when status or model changes.

**ID generation:** `browser-{platform}-{btoa(origin+pathname)}` — stable ID per tab.

### Detection Priority Hierarchy

Same for all platforms:

```
1. Tool Use (highest priority)
   └── Visible tool indicator (artifact, code execution, search)

2. Streaming Response
   ├── Stop button + content → responding
   └── Stop button + no content → thinking

3. Thinking Indicator
   └── Visible dots/spinner/text → thinking

4. Completion Transition
   └── _wasStreaming reset → task_complete (once, 3s → idle)

5. Idle (default)
```

### Model → Tier Mapping

| Keywords                                                 | Tier   |
|----------------------------------------------------------|--------|
| -mini, haiku, nano, flash, gpt-3.5, codex-spark, instant | junior |
| opus, ultra, gpt-4o, gpt-5.4, o1, o3                     | expert |
| sonnet, pro, gpt-4, gpt-5-codex, gpt-5.3-codex           | senior |
| *(everything else)*                                      | middle |

> **Order matters:** Junior is checked first so that `-mini` matches before `gpt-4o` (otherwise `gpt-4o-mini` would fall into expert). Logic is identical to Rust `Tier::from_model()` in `agent_state.rs`.

### CSS Selectors

Each platform uses 3–7 fallback CSS selectors for resilience against UI updates. Visibility check: `getComputedStyle()` → `display ≠ none && visibility ≠ hidden && opacity ≠ "0"`.

SPA navigation detection: MutationObserver on `document.body` + `location.href` check → reinitialization after 800ms.

For CSS selector details see [ARCHITECTURE.md](./ARCHITECTURE.md) § 5.3.

---

## 9. Tauri HTTP Server (backend)

**File:** `src-tauri/src/ipc/extension_server.rs`

Minimal HTTP/1.1 server on `tokio::net::TcpListener` (no external HTTP dependencies):

- **Bind:** `127.0.0.1:{extension_port}` (default `7842`, configurable in `config.toml`)
- **Endpoint:** `POST /extension`
- **Protocol:** JSON body with `Content-Length` header

### Dispatch

| `type`        | Action                                                                                                                                    |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `agent:state` | Parse `AgentState`, re-derive tier via `Tier::from_model()`, check `maxAgents`, call `registry.register()` / `registry.update()`          |
| `agent:lost`  | Parse `{ id }`, call `registry.remove()`                                                                                                  |
| `heartbeat`   | Return `200 OK`                                                                                                                           |

### Responses

| Code  | Reason                                      |
|-------|---------------------------------------------|
| `200` | Successful processing                       |
| `400` | Invalid JSON or missing payload             |
| `404` | Wrong path (not `/extension`)               |
| `405` | Wrong method (not `POST`)                   |

### Security

- Localhost only (bind `127.0.0.1`)
- `maxAgents` enforcement (4th level of validation)
- Tier is recalculated on the server (extension value is not trusted)
