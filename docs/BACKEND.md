# src-tauri/ — Rust Backend (Tauri v2)

Rust backend for the OfficeAI desktop application. Scans OS processes, parses JSONL logs, classifies agent states, and emits events to the Svelte frontend via Tauri IPC.

## Directory Structure

```
src-tauri/
├── Cargo.toml
├── Cargo.lock
├── build.rs
├── tauri.conf.json
├── capabilities/
│   └── default.json
├── icons/
└── src/
    ├── main.rs
    ├── lib.rs
    ├── logger.rs
    ├── error.rs
    ├── discovery/
    ├── interceptor/
    ├── ipc/
    └── models/
```

### Root Files

**`Cargo.toml`** — Package manifest for the `office-ai` crate. Defines the library target (`office_ai_lib` with `lib`, `cdylib`, `staticlib` crate types) and the binary target (`OfficeAI`). Lists all runtime dependencies (tauri, tokio, sysinfo, serde, chrono, regex, etc.) and dev-dependencies (tempfile). Edition: 2021.

**`Cargo.lock`** — Auto-generated lock file that pins exact versions of all transitive dependencies. Ensures reproducible builds across environments. Committed to git for the binary application.

**`build.rs`** — Minimal Tauri build script. Calls `tauri_build::build()` to generate platform-specific glue code (window creation, resource bundling, code signing hooks) at compile time.

**`tauri.conf.json`** — Tauri application configuration. Defines the product name (`OfficeAI`), version (`0.1.0`), identifier (`com.office-ai.app`), window properties (1280x800, resizable), build commands (`npm run dev` / `npm run build`), dev server URL (`localhost:1420`), bundle settings (icons, targets), and plugin permissions (shell open).

### Directories

#### `capabilities/`

Defines the security permissions for the Tauri v2 application. Capabilities restrict what the frontend JavaScript code is allowed to do.

**`default.json`** — Default capability set for the main window.

**Granted permissions:**
- `core:default` — standard Tauri core capabilities
- `shell:allow-open` — open URLs in the default browser
- `core:window:allow-set-badge-count` — update dock/taskbar badge (macOS, Linux)
- `dialog:default` — system file dialogs (used for bug report export)

**Scope:** Applies only to the `main` window. Identifier: `default`.

When adding new Tauri plugins or features that require frontend access, add the corresponding permission string to the `permissions` array in `default.json`. See the [Tauri v2 capabilities documentation](https://tauri.app/develop/capability/) for available permissions.

#### `icons/`

Platform-specific icon files for the OfficeAI desktop application. Referenced in `tauri.conf.json` under `bundle.icon`.

| File | Size | Platform |
|---|---|---|
| `32x32.png` | 32x32 px | Windows taskbar, Linux tray |
| `128x128.png` | 128x128 px | Windows/Linux app icon, embedded in dev mode |
| `128x128@2x.png` | 256x256 px | HiDPI/Retina displays |
| `icon.icns` | Multi-size | macOS (Finder, Dock, Spotlight) |
| `icon.ico` | Multi-size | Windows (Explorer, taskbar) |
| `icon.png` | Source | Generic icon (tracked in git) |

- `128x128.png` is embedded at compile time in `lib.rs` via `include_bytes!()` and set as the window icon during app setup
- All icons in the bundle are packaged into the final installer (DMG, MSI, AppImage)
- To update: replace the icon files and rebuild. The `.icns` and `.ico` formats can be generated from a high-resolution PNG using tools like `tauri icon` or online converters

### Source Files (`src/`)

**`main.rs`** — Binary entry point (6 lines). Calls `office_ai_lib::run()`. The `windows_subsystem = "windows"` attribute suppresses the console window on Windows in release builds.

**`lib.rs`** — Core orchestrator (~870 lines). Initializes the logger, loads config from TOML, creates the shared `AgentRegistry`, builds the `ParserRegistry` with `ClaudeCodeParser`, and wires 5 concurrent Tokio tasks via `mpsc` channels: Process Scanner, Log Watcher, Scanner Consumer, Log Consumer, and Auto-Idle Consumer. Also contains `path_to_agent_id()` (derives log IDs from file paths) and `resolve_agent_id()` (cwd-based agent-process correlation with 30s stale mapping expiry). Includes 15 unit tests.

**`logger.rs`** — File-based logger that writes timestamped messages to `logs/app.log`. Truncates the log file on each startup for a fresh session. Provides the `app_log!(category, format, ...)` macro used throughout the codebase, and `read_recent_lines(n)` for bug report collection.

**`error.rs`** — Custom error types using `thiserror`. Defines `AppError` with variants: `AgentNotFound`, `ConfigError`, `IoError`, `SerdeError`, `WatchError`, `TauriError`. Implements `From<AppError> for String` for Tauri command compatibility.

### Module: `discovery/` — Agent Discovery

Discovers running AI agent processes via OS introspection and monitors JSONL log files for activity. Manages the central agent registry that stores all known agents.

**`process_scanner.rs`** — Scans OS processes every 2 seconds. Uses `ps axo pid,ppid,tty,args` as the primary process source (reliable on macOS, even from GUI/Tauri apps). `sysinfo` is used only for supplementary metadata (cwd, start_time). Detects Claude Code and Gemini CLI by matching process names/cmdlines against configurable regex patterns.

Key components:
- `ScannerEvent` — enum: `AgentFound(AgentState, Option<String>)` | `AgentLost(String)`
- `DetectedProcess` — intermediate struct with `pid`, `name`, `cmdline`, `start_time`, `cwd`
- `PsEntry` — raw process entry from `ps` with pid, ppid, tty, args
- `get_ps_entries()` — enumerates all processes via `ps` (Unix) or returns empty (Windows)
- `run_scanner()` — async loop: scans processes, emits events via `tokio::mpsc`
- `scan_processes_with_patterns()` — ps-driven scan with configurable patterns
- `matches_agent_pattern()` — regex-based process matching
- `derive_agent_name()` — extracts script name from Node.js cmdlines (e.g. `node .../gemini` → `gemini`)
- `infer_initial_model()` — determines agent model from name + cmdline via `MODEL_KEYWORDS` lookup table (returns "unknown" for unrecognized processes)
- `process_to_agent_state()` — converts `DetectedProcess` → `AgentState`

Filtering layers:
1. Regex pattern matching against process name and cmdline
2. Blocklist (`ssh`, `git`, `curl`, etc.) — ignores non-agent executables
3. Version number detection — filters out Claude Code's semver-named worker processes
4. TTY check (from ps tty field) — filters out background daemons (Unix only)
5. Parent-child dedup — removes child processes whose parent is also detected (e.g. Gemini CLI spawns a child node process with same args)

**`log_watcher.rs`** — Format-agnostic polling loop that checks log directories every 500ms for new content. Delegates file reading to `LogFileReader` implementations (one per format). Handles file rotation detection.

Key components:
- `RawLogLine` — struct: `{ path: PathBuf, line: String }`
- `run_log_watcher(readers, watch_dirs, custom_paths, tx)` — async polling loop, accepts pre-built readers and pre-resolved directories
- `collect_files()` — collects all files from watched directories (readers filter by `can_handle()`)

**`log_reader.rs`** — `LogFileReader` trait + format-specific implementations. Each reader encapsulates position tracking and incremental reading for a specific file format.

Key components:
- `LogFileReader` trait: `can_handle()`, `read_new()`, `seed()`
- `JsonlReader` — reads JSONL files line-by-line, tracks byte positions (used by Claude Code)
- `JsonArrayReader` — reads JSON-array session files, tracks message counts (used by Gemini CLI)

**`agent_registry.rs`** — In-memory `HashMap<String, AgentState>` protected by `Arc<RwLock<...>>`. Every mutation emits Tauri events to the frontend and updates the dock/taskbar badge.

Key components:
- `AgentRegistry` — central registry struct
- `SharedRegistry` — type alias for `Arc<RwLock<AgentRegistry>>`
- `register()` → emits `agent:found`
- `update()` → emits `agent:state-changed`
- `remove()` → emits `agent:lost`
- `active_count()` — counts non-Idle, non-Offline, non-Error agents (used for badge)
- `total_tokens_in()` / `total_tokens_out()` — aggregate token stats

**Data flow:**
```
OS Processes → process_scanner → ScannerEvent → scanner_consumer (lib.rs)
                                                        │
                                                        ▼
                                                 AgentRegistry
                                                        │
                                                        ▼
~/.claude/*.jsonl → log_watcher → RawLogLine → log_consumer (lib.rs)
```

**Agent-process correlation:** The scanner registers agents as `pid-{PID}` with their cwd. The log watcher derives IDs as `log-{project-dir}--{session-uuid-prefix}`. The `resolve_agent_id()` function in `lib.rs` bridges the gap using:
- CWD-based matching (when log provides CWD, e.g. Claude Code JSONL)
- Model-hint fallback (when CWD is unavailable, e.g. Gemini CLI — matches by model affinity alone)
- Stale mapping cache with 30s expiry
- Deterministic PID tiebreaker (lowest PID wins among equal candidates)

### Module: `interceptor/` — Log Parsing & State Classification

Pluggable parser architecture for translating AI agent log formats into a common `ParsedEvent`, plus a finite state machine (FSM) that classifies and debounces agent state transitions.

**`parser_trait.rs`** — Defines the `AgentLogParser` trait — the self-contained interface for pluggable parsers. Each parser encapsulates all agent-specific knowledge: log format, ID derivation, directory discovery, and file reader creation.

```rust
pub trait AgentLogParser: Send + Sync {
    fn name(&self) -> &str;
    fn can_parse(&self, path: &Path, first_line: &str) -> bool;
    fn parse_line(&self, line: &str) -> Option<ParsedEvent>;
    fn path_to_agent_id(&self, path: &Path) -> String;     // ID from log file path
    fn log_roots(&self) -> Vec<PathBuf>;                    // root directories to watch
    fn resolve_log_dirs(&self, root: &Path) -> Vec<PathBuf>; // expand root → project dirs
    fn create_reader(&self) -> Box<dyn LogFileReader>;       // format-specific file reader
}
```

**`parser_registry.rs`** — Routes log lines and ID derivation to the correct parser implementation.

Routing priority:
1. Explicit directory binding (longest prefix match via `Path::starts_with()`)
2. Auto-detection fallback via `can_parse()`
3. `None` if no parser claims the line

Key components:
- `ParserRegistry` — stores parsers and directory bindings
- `register_parser()` → returns index for `bind_directory()`
- `bind_directory()` → associates a path prefix with a parser
- `parse_line(path, line)` → routes and parses
- `path_to_agent_id(path)` → delegates ID derivation to the matched parser

**`claude_code_parser.rs`** — Parses Claude Code JSONL session logs (`~/.claude/projects/<project>/<session>.jsonl`).

JSONL type → Agent status mapping:

| JSONL `type` | Condition | Status |
|---|---|---|
| `user` | Real text message | `Thinking` |
| `user` | tool_result-only array | `ToolUse` (extracts completed sub-agent IDs) |
| `assistant` | `stop_reason: "end_turn"` | `TaskComplete` |
| `assistant` | Content has `tool_use` block | `ToolUse` |
| `assistant` | Otherwise | `Responding` |
| `progress` | Any | `ToolUse` |
| `error` | Any | `Error` |

Filtering:
- `isMeta: true` messages — skipped (internal bookkeeping)
- XML command tags (`<command-name>`, `<local-command-*>`) — filtered from status and text
- tool_result-only arrays — not treated as real user prompts

Extracted data:
- `status` — agent state
- `model` — from `message.model` (priority) or top-level `model` (fallback)
- `tokens_in/out` — from `message.usage` (includes cache tokens)
- `sub_agents` — from `tool_use` blocks named "Task" or "Agent"
- `completed_sub_agent_ids` — from `tool_result` blocks
- `current_task` — extracted text content (truncated to 200 chars)
- `cwd` — working directory for agent-process correlation

**`generic_cli_parser.rs`** — Heuristic-based parser for unknown agent types. Not currently used in production. Classifies output by keyword matching: error keywords (`error`, `failed`, `fatal`), completion keywords (`done`, `complete`, `finished`), tool-use patterns (backtick commands, `Running`/`Executing` prefixes), thinking (>2s of silence).

**`parsed_event.rs`** — Common `ParsedEvent` struct produced by all parsers:

```rust
pub struct ParsedEvent {
    pub status: Status,
    pub model: Option<String>,
    pub current_task: Option<String>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub sub_agents: Vec<SubAgentInfo>,
    pub completed_sub_agent_ids: Vec<String>,
    pub timestamp: String,
    pub cwd: Option<String>,
}
```

**`state_classifier.rs`** — Per-agent FSM with debounce (300ms) that enforces valid state transitions.

FSM transition matrix:
```
Idle → Thinking, WalkingToDesk, Offline
WalkingToDesk → Idle, Thinking
Thinking → Thinking, Responding, ToolUse, TaskComplete, Error, Idle
Responding → Thinking, Responding, ToolUse, TaskComplete, Error, Idle
ToolUse → Thinking, Responding, ToolUse, TaskComplete, Error, Idle
TaskComplete → Idle, Thinking
Error → Idle, Thinking
Offline → Idle
```

Auto-idle timeouts:
- `TaskComplete` → Idle after 3s
- `Responding` → Idle after 10s
- `Thinking` / `ToolUse` → no timeout (explicit completion signals in JSONL)

Stale auto-resolve: When a transition is invalid from the current status, the classifier checks if the status has exceeded its inactivity timeout. If stale, it treats the current status as `Idle` and retries the transition.

**Data flow:**
```
RawLogLine → ParserRegistry → ParsedEvent → StateClassifier → TransitionResult
                  │                                                   │
                  ▼                                                   ▼
         ClaudeCodeParser                              Updated / Debounced / Invalid
```

### Module: `ipc/` — Tauri IPC Layer

Bridge between the Rust backend and the Svelte frontend. Contains event emitters (Rust → JS) and invoke command handlers (JS → Rust).

**`events.rs`** — Helper functions to emit typed Tauri events to the frontend.

Events (Rust → JavaScript):

| Event | Payload | Emitter |
|---|---|---|
| `agent:found` | `{ agent: AgentState }` | `emit_agent_found()` |
| `agent:lost` | `{ id: string }` | `emit_agent_lost()` |
| `agent:state-changed` | `{ agent: AgentState }` | `emit_agent_state_changed()` |
| `office:layout-changed` | `{ layout: OfficeLayout }` | `emit_office_layout_changed()` *(planned — defined but not yet emitted)* |

Badge management:
- `update_badge(handle, active_count)` — sets dock/taskbar badge with active agent count
- `badge_count()` — converts count to `Option<i64>` (0 → `None` to remove badge)

**`commands.rs`** — Tauri invoke handlers exposed to the frontend.

Commands (JavaScript → Rust):

| Command | Signature | Description |
|---|---|---|
| `get_all_agents` | `() → AgentState[]` | All registered agents |
| `get_agent` | `(id: string) → AgentState \| null` | Single agent by ID *(planned — implemented but not yet called from frontend)* |
| `get_config` | `() → Partial<Settings>` | Backend settings as JSON |
| `set_config` | `(key: string, value: string) → void` | Update and persist a config value |
| `get_stats` | `() → AppStats` | Aggregate statistics |
| `generate_bug_report` | `() → void` | Collect diagnostics, open save dialog |

Config keys accepted by `set_config`:
- `scanInterval` / `scan_interval_ms` — process scan interval
- `idle_timeout_ms` — auto-idle timeout
- `state_debounce_ms` — FSM debounce window
- `max_agents` — maximum tracked agents
- `animation_speed` — renderer animation speed
- `theme` — UI theme name
- `sound_enabled` — boolean
- `show_agent_metrics` — boolean
- `customLogPaths` — newline-separated directory paths

Shared state:
- `AppState` — Tauri-managed state containing `registry`, `config`, and `start_time`
- `persist_config()` — writes `AppConfig` to `~/.config/office-ai/config.toml`

**Data flow:**
```
Frontend (Svelte)
    │
    ├── listen("agent:found")     ◄── events.rs
    ├── listen("agent:lost")      ◄── events.rs
    ├── listen("agent:state-changed") ◄── events.rs
    │
    ├── invoke("get_all_agents")  ──► commands.rs
    ├── invoke("set_config")      ──► commands.rs → config.toml
    └── invoke("get_stats")       ──► commands.rs
```

### Module: `models/` — Data Structures

Shared data structures that mirror the TypeScript types in `src/lib/types/`. TypeScript is the source of truth — when adding or changing a field, update both TypeScript and Rust definitions.

**`agent_state.rs`** — Core domain types for agent representation and office layout.

Agent types:

| Type | Variants / Fields | Serde |
|---|---|---|
| `Tier` | `Expert`, `Senior`, `Middle`, `Junior` | `snake_case` |
| `Status` | `Idle`, `WalkingToDesk`, `Thinking`, `Responding`, `ToolUse`, `Collaboration`, `TaskComplete`, `Error`, `Offline` | `snake_case` |
| `IdleLocation` | `WaterCooler`, `Kitchen`, `Sofa`, `MeetingRoom`, `StandingDesk`, `Desk`, `Bathroom`, `HrZone`, `Lounge` | `snake_case` |
| `Source` | `Cli`, `BrowserExtension`, `SdkHook` | `snake_case` |
| `SubAgentInfo` | `{ id, description }` | `camelCase` |
| `AgentState` | 14 fields: id, pid, name, model, tier, role, status, idle_location, current_task, tokens_in/out, sub_agents, last_activity, source | `camelCase` |

Tier inference — `Tier::from_model()` maps model names to tiers:
- **Expert:** opus, ultra, gpt-4o, o1-*, o3-* (not mini)
- **Senior:** sonnet, pro, gpt-4 (not gpt-4o)
- **Junior:** haiku, nano, flash, gpt-3.5, *-mini
- **Middle:** everything else

Office layout types:
- `LayoutSize` — `Small`, `Medium`, `Large`, `Campus`
- `GridPosition` — `{ col, row }`
- `ScreenPosition` — `{ x, y }`
- `DeskAssignment` — `{ agent_id, position, is_occupied }`
- `Zone` — `{ id, zone_type, position, capacity, current_occupants }`
- `OfficeLayout` — `{ size, width, height, desks, zones, walkable_grid }`

Event payloads:
- `AgentFoundPayload` — `{ agent: AgentState }`
- `AgentLostPayload` — `{ id: String }`
- `AgentStateChangedPayload` — `{ agent: AgentState }`
- `OfficeLayoutChangedPayload` — `{ layout: OfficeLayout }`
- `AppStats` — `{ total_agents, active_agents, total_tokens_in/out, uptime_seconds }`

Event name constants (`event_names` module):
- `AGENT_FOUND` = `"agent:found"`
- `AGENT_LOST` = `"agent:lost"`
- `AGENT_STATE_CHANGED` = `"agent:state-changed"`
- `OFFICE_LAYOUT_CHANGED` = `"office:layout-changed"` *(planned — not yet emitted)*

**`config.rs`** — Application configuration loaded from `~/.config/office-ai/config.toml`.

`AppConfig` fields and defaults:

| Field | Type | Default |
|---|---|---|
| `scan_interval_ms` | `u64` | 2000 |
| `custom_log_paths` | `Vec<PathBuf>` | `[]` |
| `idle_timeout_ms` | `u64` | 3000 |
| `max_agents` | `u32` | 20 |
| `theme` | `String` | "modern" |
| `sound_enabled` | `bool` | false |
| `state_debounce_ms` | `u64` | 300 |
| `animation_speed` | `f64` | 1.0 |
| `show_agent_metrics` | `bool` | true |
| `agent_process_patterns` | `Vec<String>` | ["claude", "node.*claude", "gemini", "node.*gemini"] |
| `log_roots` | `Vec<PathBuf>` | [~/.claude/projects, ~/.gemini/tmp] |
| `work_timeout_ms` | `u64` | 120000 |
| `responding_timeout_ms` | `u64` | 30000 |
| `debug_mode` | `bool` | false |

**`bug_report.rs`** — Data structures for diagnostics export. Rust-only — not mirrored in TypeScript (written directly to file, not sent via IPC).

- `BugReport` — `{ generated_at, app_version, os, config, stats, recent_logs }`
- `OsInfo` — `{ name, os_version, arch, cpu_count, total_memory_mb }`

Serde conventions:
- All structs use `#[serde(rename_all = "camelCase")]`
- All enums use `#[serde(rename_all = "snake_case")]`
- All types derive `Serialize, Deserialize, Clone, Debug`

## Architecture

### Module Structure

```
src-tauri/src/
├── lib.rs              — entry point, initialization, wiring 5 async tasks
├── logger.rs           — file logging with categories
├── discovery/
│   ├── mod.rs
│   ├── process_scanner.rs   — OS process detection via ps + sysinfo
│   ├── log_watcher.rs       — format-agnostic polling loop (delegates to LogFileReader)
│   ├── log_reader.rs        — LogFileReader trait + JsonlReader + JsonArrayReader
│   └── agent_registry.rs    — agent registry (shared state)
├── interceptor/
│   ├── mod.rs
│   ├── parsed_event.rs        — common ParsedEvent type for all parsers
│   ├── parser_trait.rs        — AgentLogParser trait (self-contained parser interface)
│   ├── parser_registry.rs     — parser registry (routing by directory/auto-detect)
│   ├── claude_code_parser.rs  — Claude Code JSONL parsing + ClaudeCodeParser struct
│   ├── gemini_cli_parser.rs   — Gemini CLI JSON-array parsing + GeminiCliParser struct
│   ├── generic_cli_parser.rs  — heuristic parser for other CLIs
│   └── state_classifier.rs   — FSM state classifier
├── ipc/
│   ├── mod.rs
│   ├── events.rs        — Tauri event emitters
│   └── commands.rs      — Tauri invoke commands
└── models/
    ├── mod.rs
    ├── agent_state.rs   — AgentState, Status, Tier, Source, IdleLocation
    └── config.rs        — AppConfig, TOML persistence
```

### Channel Topology (5 Async Tasks)

In `lib.rs`, 3 `tokio::mpsc` channels are created and 5 tasks are spawned:

```
Channel 1: scanner_tx/scanner_rx  (capacity: 128)  — ScannerEvent
Channel 2: log_tx/log_rx          (capacity: 512)  — RawLogLine
Channel 3: idle_tx/idle_rx        (capacity: 64)   — (String, Status, Instant)

TASK 1: Process Scanner
├─ Enumerates processes via `ps` (Unix) or sysinfo fallback (Windows) every 2s
├─ Enriches with sysinfo metadata (cwd, start_time) via cached System instance
├─ Filters: regex → blocklist → version check → TTY check
└─ Sends → scanner_tx: AgentFound(AgentState) | AgentLost(id)

TASK 2: Scanner Consumer
├─ Receives ← scanner_rx
├─ AgentFound → registry.register(agent) → emit agent:found + update_badge
└─ AgentLost → registry.remove(id) → emit agent:lost + update_badge

TASK 3: Log Watcher
├─ Polls pre-resolved dirs every 500ms using LogFileReader implementations
├─ JsonlReader: tracks byte positions (JSONL files)
├─ JsonArrayReader: tracks message counts (JSON-array session files)
├─ Detects file rotation (size < pos → reset)
└─ Sends → log_tx: RawLogLine { path, line }

TASK 4: Log Consumer
├─ Receives ← log_rx
├─ Parses JSON → ParserRegistry.parse_line() → ParsedEvent
├─ Classifies → state_classifier.transition() → TransitionResult
├─ Resolves ID via log→registry mapping cache
├─ Recalculates tier: Tier::from_model(event.model) → agent.tier
├─ Merges tokens (cumulative), updates status
├─ registry.update() → emit agent:state-changed + update_badge
├─ On TaskComplete → sends → idle_tx: (id, Idle, scheduled_at) with 3s delay
└─ On Responding → idle_tx: (id, Idle, scheduled_at) with 10s delay
   (Thinking/ToolUse — no timeout, completion determined by explicit JSONL signals)

TASK 5: Auto-Idle Consumer
├─ Receives ← idle_rx: (agent_id, status, scheduled_at)
├─ Checks: agent.status ∈ {TaskComplete, Thinking, Responding, ToolUse}?
├─ Checks: agent.last_activity NOT newer than scheduled_at? (with 100ms tolerance)
│   └─ If last_activity newer → timer discarded (log: "timer discarded")
├─ Checks: agent.sub_agents empty?
│   └─ If sub_agents not empty → timer skipped (log: "N sub-agents still running")
├─ registry.update(status=Idle, sub_agents=[])
└─ emit agent:state-changed + update_badge
```

### Process Scanner — Detection Algorithm

**Filtering stages** (sequential):

1. **Pattern matching** — regex or substring against process name/cmdline
   - Built-in patterns: `["claude", "node.*claude"]`

2. **Blocklist** — exclude system utilities
   ```
   ["ssh", "sshd", "git", "scp", "sftp", "rsync", "curl", "wget"]
   ```

3. **Version number filter** — reject short-lived Node.js workers
   - Rejects names like `"2.1.62"`

4. **TTY check** — interactive processes only
   ```
   ps -o tty= -p <pid>
   tty empty, "??" or "?" → reject
   ```

**Model and tier detection:**
- At scan time: model inferred via `MODEL_KEYWORDS` table (claude, gemini, aider, cursor, copilot → corresponding model; unrecognized → "unknown"), `tier = Middle` (temporary value)
- Real model arrives from JSONL logs via `message.model` field
- Tier recalculation: `Tier::from_model()` — opus → Expert, sonnet → Senior, haiku → Junior, default (including "unknown") → Middle

### Log Watcher — Incremental Reading

The log watcher is format-agnostic. Each parser creates its own `LogFileReader` (via `create_reader()`), and the watcher delegates to the first reader that `can_handle()` each file.

```
readers: Vec<Box<dyn LogFileReader>>  — one per parser (JsonlReader, JsonArrayReader, etc.)
watch_dirs: Vec<PathBuf>              — pre-resolved by parsers via resolve_log_dirs()

Loop (every 500ms):
  1. Collect all files from watch_dirs
  2. For each file:
     a. Find first reader where can_handle(path) == true
     b. reader.read_new(path) → Vec<String>
     c. Send each line as RawLogLine via channel
```

**Seed on startup:** for each existing file, the matching reader's `seed()` is called to skip old content.

### Pluggable Parser Architecture

The parser system is built on the `AgentLogParser` trait — each AI agent implements its own self-contained parser. Adding a new agent = creating one new parser file + registering it in `lib.rs`. Zero changes to `log_watcher.rs` or other existing files.

```rust
pub trait AgentLogParser: Send + Sync {
    fn name(&self) -> &str;
    fn can_parse(&self, path: &Path, first_line: &str) -> bool;
    fn parse_line(&self, line: &str) -> Option<ParsedEvent>;
    fn path_to_agent_id(&self, path: &Path) -> String;       // derive agent ID from log path
    fn log_roots(&self) -> Vec<PathBuf>;                      // root directories to watch
    fn resolve_log_dirs(&self, root: &Path) -> Vec<PathBuf>;  // expand root → project dirs
    fn create_reader(&self) -> Box<dyn LogFileReader>;         // format-specific file reader
}
```

**ParserRegistry** routes logs and ID derivation to the correct parser:
1. **Explicit binding** — directory-to-parser binding (longest prefix match)
2. **Auto-detection** — fallback via `can_parse()` on each parser
3. **None** — if no parser claims the line

All parsers return a common `ParsedEvent` type:

```rust
pub struct ParsedEvent {
    pub status: Status,
    pub model: Option<String>,          // from message.model (fallback: top-level model)
    pub current_task: Option<String>,   // truncated to 200 chars, XML commands filtered
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub sub_agents: Vec<SubAgentInfo>,
    pub completed_sub_agent_ids: Vec<String>,
    pub timestamp: String,              // ISO 8601
    pub cwd: Option<String>,            // working directory from log
}
```

**Adding a new agent parser:**
1. Create `src-tauri/src/interceptor/<agent>_parser.rs` implementing `AgentLogParser` (all 7 methods)
2. Add `pub mod <agent>_parser` in `interceptor/mod.rs`
3. Add `Arc::new(<Agent>Parser)` to the `parsers` vec in `lib.rs` — the loop auto-registers, binds directories, and creates readers
4. Update `agent_process_patterns` in config defaults if the agent has a detectable process

#### Claude Code JSONL Parser

`ClaudeCodeParser` — implementation of `AgentLogParser` for Claude Code JSONL logs.

**Model extraction:** In real Claude Code JSONL logs, the model is in `message.model` (e.g. `"claude-opus-4-6"`), not at the top level. Parser reads `message.model` with priority, falling back to top-level `model` for compatibility.

**XML filtering for `currentTask`:** The `is_command_xml()` function strips Claude Code XML tags from task text:
- `<command-name>...</command-name>` — slash command names
- `<command-message>...</command-message>` — command messages
- `<local-command-*>...</local-command-*>` — local commands

This prevents internal XML tags from appearing in agent speech bubbles.

**Log type → Status mapping:**

| Log type (v2)      | Legacy              | Status         |
|--------------------|---------------------|----------------|
| `"user"`           | `"user_message"`    | Thinking       |
| `"assistant"`      | `"assistant_start"` | *see below*    |
| `"progress"`       | `"tool_result"`     | ToolUse        |
| `"error"`          | —                   | Error          |
| `"queue-operation"` | —                  | ToolUse *(only on async sub-agent completion)* |
| —                  | `"assistant_end"`   | TaskComplete   |

**Assistant event classification:**
- `stop_reason == "end_turn"` → TaskComplete
- Contains `tool_use` blocks → ToolUse
- Otherwise → Responding

**Token extraction:**
```
tokens_in = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
tokens_out = output_tokens
```

#### Gemini CLI JSON-Array Parser

`GeminiCliParser` — implementation of `AgentLogParser` for Gemini CLI session files (`~/.gemini/tmp/<project>/chats/session-*.json`).

**Log format:** JSON arrays (or objects with `"messages"` field), not JSONL. The entire file is re-read and diffed by message count on each poll cycle.

**Message type → Status mapping:**

| `type` field | Condition | Status |
|---|---|---|
| `"user"` | Has text content | `Thinking` |
| `"user"` | Empty content | *skipped* |
| `"gemini"` | Has `toolCalls` array | `ToolUse` |
| `"gemini"` | No tool calls | `Responding` |
| `"info"` | Text contains "cancelled" | `Error` |
| `"info"` | Otherwise | *skipped* |

**Content extraction:** Supports two formats — old (`parts[].text`) and new (`content` as string or `content[].text` array).

**Sub-agents:** Always empty (`sub_agents: vec![]`). Gemini `toolCalls` are regular tool use, not sub-agents — unlike Claude Code's Task/Agent tools. This prevents phantom sub-agents from blocking auto-idle transitions.

### Parser Capabilities Comparison

Not all parsers extract the same data. This table documents current capabilities and known limitations per parser.

| Capability | Claude Code | Gemini CLI | Impact |
|---|---|---|---|
| **Log format** | JSONL (line-by-line, byte position tracking) | JSON array (full re-read, message count tracking) | Gemini has higher I/O per poll cycle |
| **Status: Thinking** | `type="user"` with real text | `type="user"` with text | Same |
| **Status: Responding** | `type="assistant"` without tool_use | `type="gemini"` without toolCalls | Same |
| **Status: ToolUse** | `type="assistant"` with tool_use / `type="progress"` | `type="gemini"` with toolCalls | Same |
| **Status: TaskComplete** | `stop_reason="end_turn"` | **Not supported** | Gemini agents stay in Responding until auto-idle timeout (30s) |
| **Status: Error** | `type="error"` | `type="info"` with "cancelled" | Gemini only detects user cancellation |
| **Model extraction** | `message.model` (priority) or top-level `model` | Top-level `model` field | Same |
| **Token counting** | `message.usage` (`input + cache_read + cache_creation`) | `tokens.input` / `tokens.output` (`cached` parsed but unused) | Claude includes cache tokens in sum; Gemini does not |
| **Sub-agent detection** | `tool_use` blocks with `name="Task"` or `name="Agent"` | **Not supported** (`sub_agents` always empty) | Gemini tool calls are regular tool use, not sub-agents |
| **Sub-agent completion** | `tool_result` blocks + `queue-operation` notifications | **Not supported** (`completed_sub_agent_ids` always empty) | Gemini sub-agents are never removed from the list (cleared only on status reset) |
| **Async agent detection** | Filters "Async agent launched" results | **Not supported** | N/A for Gemini |
| **CWD (working directory)** | Extracted from JSONL `cwd` field | **Always `None`** | Gemini relies on model-hint fallback for agent-process correlation (step 4 in `resolve_agent_id`) |
| **Meta message filtering** | `isMeta: true` → skip | **No equivalent** | N/A |
| **XML command filtering** | Strips `<command-name>`, `<local-command-*>` from text | **No equivalent** | N/A |
| **ID format** | `log-{project}--{uuid_prefix_8}` | `log-{project}--{session_prefix_16}` | Different prefix lengths |

**Consequences of Gemini limitations:**

1. **No TaskComplete → 30s idle delay.** Gemini agents visually remain at their desk (Responding status) for up to 30s after finishing, until the `responding_timeout_ms` auto-idle timer fires. Claude agents transition to TaskComplete → Idle in ~3s.

2. **Sub-agents never cleared by completion.** For Claude, completed sub-agent IDs arrive via `tool_result` and `queue-operation` events, removing finished sub-agents from the list. For Gemini, `completed_sub_agent_ids` is always empty, so sub-agents accumulate until the next status reset (Thinking, TaskComplete, Error, or Idle).

3. **CWD unavailable → weaker agent-process correlation.** Claude logs include `cwd`, enabling precise matching with scanner-detected processes. Gemini logs have no CWD, so correlation falls back to model-hint matching (any unbound `pid-*` agent with a matching model name). With multiple Gemini instances, this can cause incorrect pairing.

### State Classifier FSM

Implements an FSM with debounce, auto-idle timeout, and inactivity timeout.

**9 states and valid transition matrix:**

```
                    ┌──────────────────────────────────────────────┐
                    │          VALID TRANSITIONS                    │
                    ├──────────────────────────────────────────────┤
 Idle              → Thinking, WalkingToDesk, Offline
 WalkingToDesk     → Idle, Thinking
 Thinking          → Thinking*, Responding, TaskComplete, ToolUse, Error, Idle
 Responding        → Thinking, Responding*, ToolUse, TaskComplete, Error, Idle
 ToolUse           → Thinking, Responding, ToolUse*, TaskComplete, Error, Idle
 TaskComplete      → Idle, Thinking
 Collaboration     → Idle, Thinking
 Error             → Idle, Thinking
 Offline           → Idle

 * Self-transitions are allowed but debounced (300ms).
   Used for token accumulation without visual state changes.
```

**Transition algorithm** (`transition(agent_id, next_status)`):

```
1. If agent is new → accept any status, record in states

2. Debounce (ONLY self-transitions):
   If next_status == current_status && elapsed < 300ms
   → TransitionResult::Debounced
   IMPORTANT: transitions to a DIFFERENT status always pass immediately.
   Critical for fast completions (Thinking → TaskComplete in <300ms).

3. FSM check: is_valid_transition(current, next)?
   Yes → accept transition (step 5)
   No → auto-resolve stale statuses:
     If current status is "stale" (elapsed ≥ timeout for that status):
     - TaskComplete: stale after 3s (idle_timeout_ms)
     - Responding: stale after 30s (responding_timeout_ms)
     - Thinking/ToolUse: stale after 120s (work_timeout_ms)
     → effective current = Idle, retry validation
     If still invalid → TransitionResult::InvalidTransition

4. Update state, record Instant::now()

5. Schedule auto-idle timer:
   TaskComplete → tokio::spawn(sleep(3s) → idle_tx.send(id, Idle, scheduled_at))
   Responding → tokio::spawn(sleep(30s) → idle_tx.send(id, Idle, scheduled_at))
   Thinking/ToolUse → tokio::spawn(sleep(120s) → idle_tx.send(id, Idle, scheduled_at))
   Debounced events update last_activity (protection against stale timers),
   but do NOT schedule new timers.

6. TransitionResult::Updated(next_status)
```

**Token decoupling from FSM:** Tokens accumulate on every ParsedEvent regardless of transition result (Updated/Debounced/Invalid). This guarantees accurate counting even for rejected transitions.

**Safety Timeouts (auto-idle):**

Each work status has a safety timeout — if no JSONL events arrive within the specified time, the agent automatically transitions to Idle. This prevents the "stuck at desk" bug when CLI exits without emitting `end_turn`.

| Status           | Timeout (default) | Config key                | Rationale                                              |
|------------------|-------------------|---------------------------|--------------------------------------------------------|
| TaskComplete     | 3s                | `idle_timeout_ms`         | Task done, quick transition to Idle                    |
| Responding       | 30s               | `responding_timeout_ms`   | Opus 4.6 can have >10s pauses between response chunks  |
| Thinking/ToolUse | 120s              | `work_timeout_ms`         | Long tools (Agent, Bash) are silent for 30-60+ seconds |

**False idle protection:** Debounced self-transitions (e.g., repeated `ToolUse → ToolUse` within the debounce window) update agent's `last_activity` even when the FSM transition is suppressed. This prevents stale timers from firing while the agent is actively working.

The auto-idle consumer checks `last_activity` before applying the transition — if the agent received new events after the timer's `scheduled_at`, the timer is discarded.

### Agent Registry + CWD Matching

```rust
pub struct AgentRegistry {
    agents: HashMap<String, AgentState>,
}
pub type SharedRegistry = Arc<RwLock<AgentRegistry>>;
```

**Mutations with automatic emit and badge update:**
- `register(agent)` → `emit_agent_found` + `update_badge`
- `update(id, state)` → `emit_agent_state_changed` + `update_badge`
- `remove(id)` → `emit_agent_lost` + `update_badge`

Each mutation calls `update_badge(handle, active_count())` — updates the numeric indicator on the app icon in dock/taskbar. When `active_count == 0` the badge is removed (`None`), when `active_count > 0` it shows the count (`Some(count)`).

**Queries:** `get(id)`, `get_all()`, `len()`, `active_count()`, `total_tokens_in()`, `total_tokens_out()`

**Bridging log-ID ↔ registry-ID (CWD-based matching):**

The scanner creates IDs as `pid-{PID}`. Logs create IDs as `log-{project}--{session_prefix}`.
The `resolve_agent_id()` function in `lib.rs` bridges them:

```
HashMap<log_id, (registry_id, last_seen: Instant)> — mapping cache

Step 1: Direct match — log_id exists in registry → return

Step 2: Cached mapping — log_id in cache?
  If mapped_id still in registry → update last_seen, return
  If mapped_id gone → remove stale entry from cache

Step 3: CWD-based matching (when log_cwd is available):
  a) Build already_mapped: mappings with last_seen < 30s (active sessions)
  b) Build ever_mapped: ALL mappings (including stale)
  c) Find pid-* agents with matching CWD, NOT in already_mapped
     CWD match: prefix match in both directions
     (JSONL cwd may be a subdirectory of process cwd and vice versa)
  d) Sort: model affinity → never-mapped preference → deterministic PID tiebreaker
  e) First candidate → cache and return

Step 4: Model-hint fallback (when log_cwd is None, e.g. Gemini CLI):
  a) If model_hint is available, find unmapped pid-* agents with matching model
  b) Sort: never-mapped preference → PID tiebreaker
  c) First candidate → cache and return

Step 5: Fallback — no matches → return log_id as-is
```

**Never-mapped preference:** new sessions get agents that have never been bound to logs, avoiding "sticky" mappings on restart.

**Staleness (30s):** old mappings are excluded from `already_mapped`, allowing pid-* agents to be reused after past sessions end.

### App Icon Badge

The app icon badge displays the count of active agents (not Idle, not Offline) in the dock (macOS) or taskbar (Linux).

**Implementation:** `update_badge()` in `ipc/events.rs`

```rust
pub fn update_badge(handle: &AppHandle, active_count: u32) {
    // active_count == 0 → None (badge removed)
    // active_count > 0  → Some(count) (shows number)
    window.set_badge_count(count)
}
```

**Call sites:**
- `AgentRegistry::register()` — new agent → badge updated
- `AgentRegistry::update()` — status changed → badge recalculated
- `AgentRegistry::remove()` — agent gone → badge updated
- `lib.rs::setup()` — on app startup, badge is reset (cleanup from previous session)

**Cross-platform support:**

| Platform          | Behavior                                                                    |
|-------------------|-----------------------------------------------------------------------------|
| macOS             | Number on Dock icon (native `NSApp.dockTile.badgeLabel`)                    |
| Linux (Unity/KDE) | Number on taskbar icon (via `libunity` / DBus)                              |
| Windows           | Not supported (`set_badge_count` API not implemented for Windows in Tauri)  |

Badge is fire-and-forget: errors are logged under `[BADGE]` category but do not interrupt app operation.

### Error Handling

```rust
pub enum AppError {
    AgentNotFound(String),
    ConfigError(String),
    IoError(std::io::Error),
    SerdeError(serde_json::Error),
    WatchError(String),
    TauriError(String),
}
```

**Strategy:**
- Critical operations → `Result<T, AppError>`
- Tauri commands → conversion to `Result<T, String>` for JSON RPC
- Polling loops → `.ok()` to ignore transient errors
- Parser → `eprintln!` for malformed JSON, continues operation

### IPC AppState

```rust
pub struct AppState {
    pub registry: Arc<RwLock<AgentRegistry>>,
    pub config: Arc<RwLock<AppConfig>>,
    pub start_time: Instant,
}
```

Managed by Tauri's `manage()` — injected into all command handlers via `State<AppState>`.

## Key Dependencies

| Crate        | Purpose                                    |
|--------------|--------------------------------------------|
| `tauri` v2   | Desktop app framework, IPC, window manager |
| `tokio`      | Async runtime (channels, timers, spawn)    |
| `sysinfo`    | Supplementary process metadata (cwd, start_time) + Windows fallback enumeration |
| `serde`      | JSON/struct serialization                  |
| `serde_json` | JSONL log parsing                          |
| `toml`       | Config file persistence                    |
| `chrono`     | Timestamps and time calculations           |
| `thiserror`  | Custom error types                         |
| `regex`      | Agent process pattern matching             |
| `dirs`       | Home/config directory detection            |

## Configuration

Persisted to `~/.config/office-ai/config.toml`. Key settings:

| Setting                  | Default              | Description                      |
|--------------------------|----------------------|----------------------------------|
| `scan_interval_ms`       | 2000                 | Process scan interval            |
| `idle_timeout_ms`        | 3000                 | Auto-idle after TaskComplete     |
| `state_debounce_ms`      | 300                  | FSM debounce window              |
| `max_agents`             | 20                   | Maximum tracked agents           |
| `agent_process_patterns` | ["claude", "node.*claude", "gemini", "node.*gemini"] | Process detection patterns |
| `log_roots`              | [~/.claude/projects, ~/.gemini/tmp] | Log directories            |
| `work_timeout_ms`        | 120000               | Safety timeout for Thinking/ToolUse |
| `responding_timeout_ms`  | 30000                | Safety timeout for Responding    |
| `debug_mode`             | false                | Verbose diagnostic logging       |

## Build Commands

```bash
cd src-tauri
cargo build                  # debug build
cargo build --release        # release build
cargo test                   # run all tests
cargo clippy -- -D warnings  # lint (warnings = errors)
cargo fmt                    # format code
```

## Logging

Application logs are written to `logs/app.log` with prefixed categories:
- `[SCANNER]` — process discovery
- `[WATCHER]` — log file polling
- `[LOG_RX]` / `[LOG_PARSE]` / `[LOG_CLASSIFY]` / `[LOG_UPDATE]` — JSONL pipeline
- `[LOG_MATCH]` — agent-process correlation
- `[TIER]` — model → tier inference
- `[AUTO_IDLE]` — idle timeout transitions
- `[BADGE]` — dock/taskbar badge updates
- `[CONFIG]` — configuration changes