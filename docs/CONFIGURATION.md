# Configuration — OfficeAI

> Complete description of all application settings. For a quick start, see [README.md](../README.md).

## Table of Contents

1. [Overview](#1-overview)
2. [Internal Settings](#2-internal-settings)
3. [Auto-save and Persistence](#3-auto-save-and-persistence)
4. [Bug Report](#4-bug-report)

---

## 1. Overview

**All settings are saved and restored after application restart.**

OfficeAI stores configuration in two locations:

| Storage                     | Path                                | Format | Description                                                                                              |
|-----------------------------|-------------------------------------|--------|----------------------------------------------------------------------------------------------------------|
| **Backend (Rust)**          | `~/.config/office-ai/config.toml`   | TOML   | Core settings (theme, sound, scan interval, max agents, animation speed, show metrics, custom log paths) |
| **Frontend (localStorage)** | `localStorage["officeai-settings"]` | JSON   | Frontend-only settings (language, showPrompts, debugMode)                                                |

On startup, the frontend loads configuration from both sources:
1. Rust settings are loaded via the IPC command `get_config`
2. Frontend-only settings are loaded from `localStorage`
3. Both sets are merged with defaults: `{ ...DEFAULTS, ...rustConfig, ...localStorageConfig }`

Backend setting changes are sent via `set_config` with a 400ms debounce. Frontend-only settings are written directly to `localStorage`.

**Rust struct:** `src-tauri/src/models/config.rs` → `AppConfig`
**Frontend store:** `src/lib/stores/settings.svelte.ts` → `Settings`

### Settings Panel

Settings are divided into three tabs:

#### General

<img src="../images/settings_general.png" alt="Settings — General" width="420" />

**Theme** — UI theme. Available options: `"modern"` (the only implemented theme). Storage: Backend. Default: `"modern"`.

**Language** — interface language. 11 supported locales: `en`, `es`, `ru`, `fr`, `de`, `hi`, `it`, `ar`, `pt`, `ja`, `zh`. Switching is **instant** — all UI strings use the reactive `t(key)` function, which reads the current locale from the settings store. Storage: localStorage (persisted across restarts). Default: `"en"`.

**Sound** — enable/disable sound effects (agent appearance, state changes, etc.). Storage: Backend. Default: `false`.

#### Discovery

<img src="../images/settings_discovery.png" alt="Settings — Discovery" width="420" />

**Scan interval** — OS process scanning interval via `sysinfo` (slider, 1s–10s). Every N seconds the Process Scanner: enumerates all processes, filters by patterns (`["claude", "node.*claude", "gemini", "node.*gemini"]`), applies blocklist, version filter and TTY check, registers discovered agents in `AgentRegistry`. Lower values detect new agents faster but increase CPU usage. On the frontend the value is stored in **seconds**; when sent to the backend it is converted to milliseconds (`scanInterval * 1000` → `scan_interval_ms`). Storage: Backend. Default: **2s**.

**Custom log paths** — additional directories for searching agent JSONL logs (textarea, one path per line). Added to the standard path `~/.claude/projects/`. On the frontend stored as `string` (multiline text), on the backend as `Vec<PathBuf>`. Storage: Backend. Default: `""` (empty string).

#### Display

<img src="../images/settings_display.png" alt="Settings — Display" width="420" />

**Max agents** — maximum number of simultaneously displayed agents (slider, 1–50). Enforced at **three levels**:

| Level          | File                        | Check                                                    |
|----------------|-----------------------------|----------------------------------------------------------|
| Rust backend   | `lib.rs` (scanner_consumer) | `registry.len() >= max` before `register()`              |
| Frontend store | `agents.svelte.ts`          | `agents.size >= getSetting("maxAgents")` in `addAgent()` |
| Renderer       | `OfficeScene.ts`            | `agentSprites.size >= maxAgents` in `onAgentFound()`     |

When the limit is decreased, existing agents are not removed — the limit applies only to new agents. Storage: Backend. Default: **20**.

**Animation speed** — multiplier for all agent animation speeds (slider, 0.5x–2.0x): `0.5` — slow (50%), `1.0` — normal speed, `2.0` — fast (200%). Affects walking, idle, working, celebrating, frustrated animations. Storage: Backend. Default: **1.0x**.

**Show agent metrics** — display the `AgentMetrics` HUD overlay with 4 metrics:

| Metric  | Description                                                       |
|---------|-------------------------------------------------------------------|
| **IN**  | Cumulative input tokens (input + cache_read + cache_creation)     |
| **OUT** | Cumulative output tokens                                          |
| **AGN** | Number of active agents                                           |
| **SUB** | Number of sub-agents                                              |

When a specific agent is selected, the HUD switches to its individual metrics. Storage: Backend. Default: `true`.

**Show prompts in bubbles** — display text speech bubbles above agents:
- **Greeting** — when an agent appears, a greeting is shown (e.g. "Hello!", "Привет!") for 2 seconds
- **Farewell** — when an agent leaves, a farewell is shown (e.g. "Bye!", "Пока!") for 2 seconds
- **Current task** — when transitioning to a working status (thinking/responding/tool_use), the agent's `currentTask` is shown

Greeting/farewell texts are localized for all 11 languages (keys `agent.greeting`, `agent.farewell`). Storage: localStorage (persisted across restarts). Default: `true`.

---

## 2. Internal Settings

These settings are stored in `config.toml` but **have no UI**. They are edited manually in the configuration file.

### 2.1. Log Roots

**Key:** `logRoots` | **Default:** `["~/.claude/projects", "~/.gemini/tmp"]`

Root directories for searching agent logs. Log Watcher expands each root one level deep into subdirectories and polls them for `.jsonl` files (Claude Code) and `session-*.json` files (Gemini CLI). If a subdirectory contains a `chats/` folder, the watcher descends into it (handles Gemini's `tmp/<project>/chats/` layout). To add a new AI agent, simply add its root log directory.

### 2.2. Agent Process Patterns

**Key:** `agentProcessPatterns` | **Default:** `["claude", "node.*claude", "gemini", "node.*gemini"]`

Regex patterns for detecting AI agent processes by name or full command line. The process scanner matches each running process against these patterns. To support a new AI CLI agent, add its name or a regex matching its cmdline.

**Config migration:** On startup, `AppConfig::ensure_defaults()` checks that all default patterns and log roots are present in the saved config. If patterns were added in a newer version (e.g., Gemini support), they are automatically merged into the saved config without removing user-customized patterns.

### 2.6. Custom Model Keywords

**Key:** `customModelKeywords` | **Type:** `HashMap<String, String>` | **Default:** `{}`

User-defined keyword → model mappings for process detection. These are checked **before** the built-in keywords (claude, gemini, aider, cursor, copilot), so custom entries take priority and can even override built-ins.

```toml
[customModelKeywords]
windsurf = "windsurf"
cody = "cody"
```

This allows adding support for new CLI agents without rebuilding the application. When a process name or command line contains the keyword (case-insensitive), it is assigned the corresponding model name.

### 2.7. Debug Mode

**Key:** `debug_mode` | **Type:** `bool` | **Default:** `false`

Enables verbose diagnostic logging in the process scanner and log consumer. When enabled, filtered-out processes and correlation details are logged under `[SCANNER]` and `[LOG_MATCH]` categories. Useful for troubleshooting agent detection issues.

### 2.3. Idle Timeout

**Key:** `idle_timeout_ms` | **Type:** `u64` (ms) | **Default:** `3000`

Timeout for auto-transitioning an agent to idle after `TaskComplete`.

### 2.4. State Debounce

**Key:** `state_debounce_ms` | **Type:** `u64` (ms) | **Default:** `300`

FSM state classifier debounce. Applied only to self-transitions (same status repeated).

### 2.5. Safety Timeouts

**Keys:** `work_timeout_ms` (default: `120000`), `responding_timeout_ms` (default: `30000`)

Internal auto-idle timeouts for the StateClassifier FSM. See [ARCHITECTURE.md](./ARCHITECTURE.md) for details on how they work.

---

## 3. Auto-save and Persistence

### Save Mechanism

**Backend settings** (theme, sound, scan interval, max agents, animation speed, show metrics, custom log paths):

1. User changes a setting in UI → `setSetting(key, value)`
2. Value is updated in `$state` (instant reactivity)
3. A **debounce timer** starts (400ms)
4. When the timer expires → IPC call `set_config(key, String(value))`
5. Rust writes the value to `AppConfig` in memory
6. Rust persists `AppConfig` to config dir (`~/Library/Application Support/office-ai/config.toml` on macOS, `~/.config/office-ai/config.toml` on Linux)

**Frontend-only settings** (language, showPrompts, debugMode):

1. User changes a setting in UI → `setSetting(key, value)`
2. Value is updated in `$state` (instant reactivity)
3. A **debounce timer** starts (400ms)
4. When the timer expires → all frontend-only settings are written to `localStorage["officeai-settings"]` as JSON

### Loading on Startup

1. `initSettingsStore()` loads frontend-only settings from `localStorage`
2. Backend settings are loaded via the IPC command `get_config`
3. Merge priority: `DEFAULTS < rustConfig < localStorageOverrides`

### Debounce

The 400ms debounce prevents excessive IPC calls when rapidly changing sliders or toggles.

If a setting is changed again within 400ms, the previous timer is cancelled and a new one starts.

---

## 4. Bug Report

The **Bug Report** button in the settings panel footer collects diagnostic information and saves it to a JSON file via a system dialog.

### Collected Data

| Field         | Description                                               |
|---------------|-----------------------------------------------------------|
| `generatedAt` | Generation time (ISO 8601)                                |
| `appVersion`  | Application version (`CARGO_PKG_VERSION`)                 |
| `os`          | OS: name, version, architecture, CPU count, RAM           |
| `config`      | Full `AppConfig` snapshot (11 fields)                     |
| `stats`       | agent count, active agents, tokens in/out, uptime         |
| `recentLogs`  | Last **500** lines from `logs/app.log`                    |

### How to Use

1. Open Settings
2. Click **Bug Report** in the bottom-left corner
3. Choose a save location in the system dialog
4. Attach the `officeai-bug-report.json` file to a GitHub Issue

No automatic submission — the file is saved **locally only**.

**IPC command:** `generate_bug_report` (Rust → system dialog → file write)
**Plugin:** `tauri-plugin-dialog`
