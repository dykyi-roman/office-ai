# ARCHITECTURE.md — OfficeAI

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Asset Generation](#2-asset-generation)
3. [Data Structures](#3-data-structures)
4. [Key Algorithms](#4-key-algorithms)
5. [Performance](#5-performance)
6. [Testing](#6-testing)
7. [Configuration](#7-configuration)

---

## 1. System Overview

OfficeAI is a Tauri v2 desktop application that visualizes running AI agents (Claude Code, Gemini CLI, Codex CLI, ChatGPT) as animated employees in an isometric 2D office. The "zero-intrusion" principle means passive observation without modifying agent processes.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        OS / File System                                 │
│                                                                         │
│  OS Processes (ps + sysinfo)       ~/.claude/projects/*/*.jsonl         │
│                                    ~/.gemini/tmp/*/chats/session-*.json │
│                                    ~/.codex/sessions/YYYY/MM/DD/*.jsonl │
│         │                                    │                          │
└─────────┼────────────────────────────────────┼──────────────────────────┘
          │                                    │
┌─────────┼────────────────────────────────────┼──────────────────────────┐
│         ▼                                      ▼                        │
│  ┌───────────────┐                  ┌────────────────────┐              │
│  │Process Scanner│                  │   Log Watcher      │              │
│  │  (every 2s)   │                  │ (500ms, JSONL+JSON)│              │
│  └──────┬────────┘                  └────────┬───────────┘              │
│         │ ScannerEvent                       │ RawLogLine               │
│         ▼                                    ▼                          │
│  ┌──────────────┐     ┌───────────────┐ ┌──────────────────┐            │
│  │   Scanner    │     │ Parser Reg.   │ │ State Classifier │            │
│  │   Consumer   │     │(Cld+Gem+Cdx)  │→│  (FSM 300ms)     │            │
│  └──────┬───────┘     └───────────────┘ └────────┬─────────┘            │
│         │                                       │                       │
│         ▼                                       ▼                       │
│  ┌─────────────────────────────────────────────────────────┐            │
│  │          Agent Registry (Arc<RwLock<HashMap>>)          │            │
│  │     register() → emit agent:found + update_badge        │            │
│  │     update()   → emit agent:state-changed + update_badge│            │
│  │     remove()   → emit agent:lost + update_badge         │            │
│  └──────────────────────┬──────────────────────────────────┘            │
│         Rust Backend    │ (src-tauri/src/)                              │
└─────────────────────────┼───────────────────────────────────────────────┘
                          │ Tauri IPC Events
┌─────────────────────────┼──────────────────────────────────────────────┐
│                         ▼                                              │
│  ┌────────────────────────────────────┐                                │
│  │  agents.svelte.ts ($state store)   │ ◄── listen("agent:*")          │
│  └──────────┬─────────────────────────┘                                │
│             │                                                          │
│  ┌──────────┴───────────┐  ┌──────────────────────────────┐            │
│  │   Svelte UI (overlay)│  │ PixiJS Renderer (isometric)  │            │
│  │   sidebar, HUD, etc. │  │ 5 z-layers, A*, FSM, NPC     │            │
│  └──────────────────────┘  └──────────────────────────────┘            │
│         Frontend (src/lib/)                                            │
└────────────────────────────────────────────────────────────────────────┘

```

### Project Structure

| Directory                     | Documentation                | Description                                                       |
|-------------------------------|------------------------------|-------------------------------------------------------------------|
| [`src/`](../src/)             | [FRONTEND.md](./FRONTEND.md) | TypeScript frontend — Svelte 5, PixiJS v8, stores, UI components  |
| [`src-tauri/`](../src-tauri/) | [BACKEND.md](./BACKEND.md)   | Rust backend — process scanner, log parser, state classifier, IPC |
| [`scripts/`](../scripts/)     | —                            | Asset generation scripts (sprites, tiles, effects)                |

---

## 2. Asset Generation

### 2.1. Tileset (generate-tiles.ts)

**37 tile types:** floors (wood, carpet, tile), walls (left, right, corner), furniture (desk, chair, sofa, bookshelf...), kitchen, bathroom, administrative.

**Tile size:** 128×64 px (isometric 2:1 ratio).

**Isometric UV system:**
```
cx = ox + 64           // center X
cy = oy                // top
x = cx + (u - v) × 64  // screen X
y = cy + (u + v) × 32  // screen Y
```

**3D objects:** three visible faces — left wall (dark), right wall (light), top face. Object heights defined in pixels (chair=16, desk=14, bookshelf=40, fridge=36).

**Textures:** wood grain (diagonal lines, opacity 0.18), carpet (diamond patterns), tile grout (grid).

**Atlas:** 6 tiles per row, PNG (RGBA8888) + PixiJS JSON.

### 2.2. Sprites (generate-sprites.ts)

**4 tiers × 56 frames = 4 separate spritesheets.**

**12 animations:**

| Animation     | Frames | Speed (ms) |
|---------------|--------|------------|
| idle_stand    | 4      | 200        |
| idle_sit      | 4      | 300        |
| walk_down     | 6      | 100        |
| walk_up       | 6      | 100        |
| walk_side     | 6      | 100        |
| typing        | 4      | 150        |
| thinking      | 6      | 250        |
| celebrating   | 4      | 200        |
| frustrated    | 4      | 200        |
| drinking      | 4      | 300        |
| coffee        | 4      | 300        |
| phone         | 4      | 400        |

**Frame size:** 64×64 px, 16 frames per row → sheet 1024×256 px.

**Character styles by tier:**

| Tier      | Body (color) | Accent     | Clothing             | Badge             |
|-----------|-------------|------------|----------------------|-------------------|
| Expert    | #1a2744     | #c9a227    | Suit + gold          | Gold + star       |
| Senior    | #2456a4     | #1a3a6e    | Shirt + 3 buttons    | Blue + checkmark  |
| Middle    | #4a7c59     | #6b6b6b    | Hoodie + pocket      | Green + leaf      |
| Junior    | #e07b39     | #cccccc    | T-shirt              | None              |

**Draw order:** shadow → legs → body → arms → head.

**Walk mechanics:** leg offset: `[0, 4, 0, -4]` px per frame, arms in counter-phase.

### 2.3. Effects (generate-effects.ts)

11 SVG files:
- **speech_bubble.svg** (200×120) — 9-slice bubble with tail
- **thinking_indicator.svg** (60×24) — 3 animated dots (CSS keyframes, bounce 1.4s)
- **Status icons** (24×24): checkmark_green, exclamation_red, gear_spinning, terminal_icon, file_icon, browser_icon
- **Badges** (16×16): badge_gold, badge_blue, badge_green (shield-shape with symbols)

---

## 3. Data Structures

### AgentState — Core Entity (14 fields)

```typescript
interface AgentState {
  id: string;              // "pid-12345" or "browser-chatgpt-abc123"
  pid: number | null;      // OS process PID (null for browser extension)
  name: string;            // "claude-1", "ChatGPT"
  model: string;           // "claude-opus-4", "gpt-4o"
  tier: Tier;              // expert | senior | middle | junior
  role: string;            // "agent" or "ai-assistant"
  status: Status;          // 9 variants (see below)
  idleLocation: IdleLocation;  // 9 zone types
  currentTask: string | null;  // Task description (≤200 chars, no XML commands)
  tokensIn: number;            // Cumulative input tokens
  tokensOut: number;           // Cumulative output tokens
  subAgents: SubAgentInfo[];   // Active sub-agents (Task/Agent tools): [{id, description}]
  lastActivity: string;        // ISO 8601 timestamp
  source: Source;          // cli | browser_extension | sdk_hook
}
```

### Enumerations

```typescript
type Status = "idle" | "walking_to_desk" | "thinking" | "responding"
            | "tool_use" | "collaboration" | "task_complete" | "error" | "offline";

type Tier = "expert" | "senior" | "middle" | "junior";

type IdleLocation = "water_cooler" | "kitchen" | "sofa" | "meeting_room"
                  | "standing_desk" | "desk" | "bathroom" | "hr_zone" | "lounge";

type Source = "cli" | "browser_extension" | "sdk_hook";
```

### OfficeLayout

```typescript
interface OfficeLayout {
  size: "small" | "medium" | "large" | "campus";
  width: number;     // grid columns
  height: number;    // grid rows
  desks: DeskAssignment[];
  zones: Zone[];
  walkableGrid: boolean[][];
}

interface GridPosition { col: number; row: number; }
interface ScreenPosition { x: number; y: number; }
interface DeskAssignment { position: GridPosition; agentId: string | null; }
interface Zone { id: string; type: ZoneType; position: GridPosition; capacity: number; currentOccupants: string[]; }
```

### AppStats

```typescript
interface AppStats {
  totalAgents: number;
  activeAgents: number;
  totalTokensIn: number;
  totalTokensOut: number;
  uptimeSeconds: number;
}
```

### AppConfig (14 fields)

```typescript
interface AppConfig {
  scanIntervalMs: number;             // default: 2000
  customLogPaths: string[];           // additional log directories
  idleTimeoutMs: number;              // default: 3000 (TaskComplete → Idle)
  maxAgents: number;                  // default: 20
  theme: string;                      // default: "modern"
  soundEnabled: boolean;              // default: false
  stateDebounceMs: number;            // default: 300
  animationSpeed: number;             // default: 1.0
  showAgentMetrics: boolean;          // default: true
  agentProcessPatterns: string[];     // default: ["claude", "node.*claude"]
  logRoots: string[];                 // default: ["~/.claude/projects"]
  workTimeoutMs: number;              // default: 120000 (Thinking/ToolUse → Idle)
  respondingTimeoutMs: number;        // default: 30000 (Responding → Idle)
  debugMode: boolean;                 // default: false
}
```

### Internal Rust Structures

```
ScannerEvent     = AgentFound(AgentState) | AgentLost(String)
RawLogLine       = { path: PathBuf, line: String }
ParsedEvent      = { status, model?, current_task?, tokens_in?, tokens_out?, sub_agents, completed_sub_agent_ids, timestamp, cwd? }
TransitionResult = Updated(Status) | Debounced | InvalidTransition
ClassifiedState  = { status: Status, last_change: Instant }
Auto-Idle msg    = (String, Status, Instant)  // (agent_id, new_status, scheduled_at)
DetectedProcess  = { pid: u32, name: String, cmdline: String, start_time: u64, cwd: Option<String> }
```

---

## 4. Key Algorithms

### 4.1. A* Pathfinding with Octile Heuristic

Optimal pathfinding on an isometric grid with 8-directional movement.

- **Heuristic:** `h = dx + dy + (√2 - 2) × min(dx, dy)` — admissible and consistent
- **Diagonal restriction:** both cardinal neighbors of a diagonal must be walkable
- **Cache:** LRU with 64 entries, key = `"from→to"`
- **Limit:** max 50 tiles per path

### 4.2. State Classification FSM with Debounce

- 9 states, allowed transition matrix (including self-transitions for Thinking/Responding/ToolUse)
- 300ms debounce: **only for self-transitions** (same status repeated). Transitions to a different status always pass through.
- Auto-resolution of stale statuses: TaskComplete (3s), Responding (30s), Thinking/ToolUse (120s)
- Auto-idle timers: TaskComplete→3s, Responding→30s, Thinking/ToolUse→120s
- Stale timer protection: each timer carries `scheduled_at`, consumer checks `last_activity`
- Sub-agents guard: auto-idle is **not applied** if the agent has active sub_agents

### 4.3. Process Detection (Hybrid: ps + sysinfo)

Claude Code, Gemini CLI, and Codex CLI are all detected by the same hybrid approach:

1. **`ps axo pid,ppid,tty,stat,args`** (Unix) — primary process enumeration, provides PID, PPID, TTY, stat, cmdline. On Windows, `sysinfo` serves as the enumeration fallback since `ps` is unavailable.
2. **`sysinfo::System`** — supplementary metadata only (cwd, start_time) for already-detected PIDs. A cached `System` instance is reused across scan cycles, refreshed via `refresh_processes()` instead of `new_all()`.
3. **4-stage filtering pipeline:**
```
regex match → blocklist check → version filter → TTY check
```
4. **Parent-child deduplication** — if both parent and child match (e.g. Gemini CLI spawns a child node process), only the parent is kept.

### 4.4. Log-ID → Registry-ID Resolution

5-step algorithm with caching and staleness control:
1. **Direct match** — log_id exists in registry
2. **Cached mapping** — `HashMap<log_id, (pid_id, last_seen)>`, with stale entry cleanup
3. **CWD matching** — prefix matching in both directions, never-mapped preference, 30s staleness, deterministic PID tiebreaker (lowest PID wins among equal candidates)
4. **Model-hint fallback** — when CWD is unavailable (e.g. Gemini CLI), match by model affinity among unmapped pid-* agents
5. **Fallback** — log_id as-is (events are ignored by registry)

### 4.5. Desk Assignment with Tier Priority

expert/senior → priority desks (first N). Fallback to standard. Random selection among available desks.

### 4.6. Idle Zone Rotation with Capacity

Random dwell: 10-30s. Preference for zones ≠ previous one. Capacity enforcement. Callback on rotation.

### 4.7. Z-ordering

`zIndex = col + row` — simple formula ensures correct draw order in isometric view (painter's algorithm).

### 4.8. Isometric Projection (~30°)

Grid→Screen: `x = (col-row)×64`, `y = (col+row)×32`. Inverse: `col = x/128 + y/64`, `row = y/64 - x/128`.

### 4.9. Walk Interpolation

Per-tick: calculate distance to next tile. On arrival — snap + pop from walkPath. Speed: 120 px/sec.

### 4.10. Token Accumulation

Tokens are summed on each ParsedEvent regardless of FSM debounce. Claude: `tokens_in = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Gemini: `tokens_in = tokens.input` (cache tokens parsed but not included in the sum).

### 4.11. Sub-Agent Tracking

Tracking nested agents (Task/Agent tools in Claude Code):

```
Spawn:      tool_use block with name="Task" or name="Agent" → add to agent.subAgents
Completion: tool_result with matching tool_use_id → remove from agent.subAgents
Auto-idle guard: if subAgents is not empty → auto-idle timer is skipped
Cleanup:    on transition to Idle → agent.subAgents = []
```

**Background (async) sub-agents:**

Claude Code launches background agents via the `Agent` tool with `run_in_background: true`. Their lifecycle differs from foreground agents:

```
1. Launch:     assistant → tool_use (name="Agent") → add to subAgents
2. Ack:        user → tool_result "Async agent launched..." → DO NOT remove (filtered)
3. Execution:  background agent performs task (subAgent remains in list)
4. Completion: queue-operation → <task-notification> with <status>completed</status>
               → extract <tool-use-id> → remove from subAgents
```

**Implementation in `claude_code_parser.rs`:**

- `is_async_launch_result()` — identifies `tool_result` blocks with text "Async agent launched..." so that `extract_completed_sub_agent_ids()` skips them
- `extract_task_notification_completion()` — parses XML `<task-notification>` from `queue-operation` entries, extracts `tool-use-id` of completed agents
- `LogEntry.content` — field for accessing raw content of `queue-operation` (stored at top-level JSON, not in `message.content`)

### 4.12. Sound Synthesis

Web Audio oscillators with ADSR envelopes. Attack 10ms → Sustain → Release 50ms. Per-event debounce 150ms. Lazy AudioContext (requires user gesture).

---

## 5. Performance

| Metric                     | Target Value                |
|----------------------------|-----------------------------|
| CPU                        | < 5%                        |
| Memory                     | < 150 MB for 20 agents      |
| State sync latency         | 200–500 ms                  |
| Process scan interval      | 2s (configurable)           |
| State change debounce      | 300ms                       |
| FPS (10 agents)            | 60fps                       |
| FPS (20 agents)            | 30fps                       |
| A* cache                   | 64 entries (LRU)            |
| Max path length            | 50 tiles                    |
| Log poll interval          | 500ms                       |
| Auto-idle timeout          | 3s (TaskComplete), 30s (Responding), 120s (Thinking/ToolUse) |
| Heartbeat (extension)      | 5s                          |
| Reconnect backoff          | 1s → 2s → 4s → ... → 30s   |

---

## 6. Testing

### TypeScript (vitest, Node environment)

- **Unit tests:** `src/lib/renderer/__tests__/`, `src/lib/stores/__tests__/`
- **PixiJS mocking:** all classes (Container, Graphics, Text, Application) are mocked — no WebGL in Node
- **AnimatableSprite:** interface specifically created for decoupling FSM from PixiJS
- **Coverage:** lines 80%, functions 80%, branches 75%
- **Alias:** `$lib` → `./src/lib`

### Rust (cargo test, inline #[cfg(test)])

- Tests inside each `.rs` file in `mod tests`
- `tempfile` for I/O tests
- Sequential execution for flaky tests: `--test-threads=1`

### Test Structure

```
src/lib/renderer/__tests__/    — pathfinder, desk manager, idle zones, animation FSM
src/lib/stores/__tests__/      — agents store, settings store
tests/integration/             — integration tests
tests/e2e/                     — E2E (Playwright)
tests/benchmarks/              — vitest bench
src-tauri/src/*/mod.rs         — Rust unit tests
```

---

## 7. Configuration

> Detailed documentation for all settings: [docs/CONFIGURATION.md](./CONFIGURATION.md)

### AppConfig

Stored in `~/.config/office-ai/config.toml`.

**14 fields** with defaults: scan_interval_ms=2000, idle_timeout_ms=3000, state_debounce_ms=300, work_timeout_ms=120000, responding_timeout_ms=30000, max_agents=20, animation_speed=1.0, theme="modern", sound_enabled=false, show_agent_metrics=true, agent_process_patterns=["claude","node.*claude","gemini","node.*gemini","codex"], log_roots=["~/.claude/projects","~/.gemini/tmp","~/.codex/sessions"], debug_mode=false.

**Frontend-only settings** (not in config.toml): `showPrompts` (speech bubbles), `debugMode`, `language` (11 locales).

**Runtime update:** Frontend → `set_config(key, value)` → Rust writes to memory + persists to TOML.

**Frontend debounce:** 400ms after the last change → IPC call.

### Office Layout

Defined in `src/lib/renderer/layouts/medium.json`: 12×10 grid, tiles (floor types + walls), furniture (6 desks + 6 chairs, sofas, water cooler, kitchen), 10 desks, 5 zones, walkableGrid, entrance door at (6,0).

Automatic size switching based on agent count (small → medium → large → campus).
