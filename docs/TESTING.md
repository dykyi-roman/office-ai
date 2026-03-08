# Testing — OfficeAI

> Project testing guide. For architecture details see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Table of Contents

1. [Overview](#1-overview)
2. [Running Tests](#2-running-tests)
3. [Test Structure](#3-test-structure)
4. [Vitest Configuration](#4-vitest-configuration)
5. [Coverage Thresholds](#5-coverage-thresholds)
6. [Rust Tests](#6-rust-tests)
7. [Benchmarks](#7-benchmarks)

---

## 1. Overview

| Category | Tests | Files | Framework |
|---|---|---|---|
| **TypeScript (unit)** | ~364 | 20 | Vitest (Node env) |
| **TypeScript (integration)** | 47 | 3 | Vitest (Node env) |
| **Rust** | 261 | 15 | cargo test |
| **Total** | **~672** | **38** | — |

---

## 2. Running Tests

### TypeScript Tests

```bash
# All TypeScript tests (unit + integration)
npm test

# Tests in a directory
npx vitest run src/lib/renderer

# Single file
npx vitest run src/lib/renderer/__tests__/pathfinder.test.ts

# By test name
npx vitest run -t "A* finds"

# Watch mode
npx vitest --watch

# With code coverage
npx vitest run --coverage
```

### Rust Tests

```bash
# All Rust tests
cd src-tauri && cargo test

# Specific module
cd src-tauri && cargo test claude_code_parser

# With stdout output
cd src-tauri && cargo test -- --nocapture

# Sequential execution (for flaky tests)
cd src-tauri && cargo test -- --test-threads=1
```

### Make Commands

```bash
make test-js       # TypeScript tests (vitest)
make test-watch    # TypeScript tests in watch mode
make test-rust     # Rust tests
make test-all      # All tests (TS + Rust)
make bench         # Benchmarks
```

---

## 3. Test Structure

### TypeScript — Unit Tests

Colocated with source code in `__tests__/` directories:

| Directory | Files | Tests | What It Tests |
|---|---|---|---|
| `src/lib/renderer/__tests__/` | 11 | ~187 | Pathfinder (A*), DeskManager, IdleZoneManager, AnimationController FSM, AgentSprite, SpeechBubble, CameraController, NpcManager, OfficeScene, Isometric utilities, Layout |
| `src/lib/stores/__tests__/` | 4 | 71 | agents store, settings store, office store, store utilities |
| `src/lib/ui/__tests__/` | 1 | 55 | UI utility functions |
| `src/lib/sound/__tests__/` | 3 | 36 | SoundEngine, SoundDefinitions, SoundEventBridge |
| `src/lib/i18n/__tests__/` | 1 | 17 | i18n translations, locale switching |

### TypeScript — Integration Tests

Located in `tests/integration/`:

| File | Tests | What It Tests |
|---|---|---|
| `renderer-store-bridge.test.ts` | 14 | Renderer-to-store bridge (agent updates) |
| `settings-persistence.test.ts` | 18 | Settings persistence (store ↔ backend) |
| `store-sync.test.ts` | 15 | Store synchronization on IPC events |

### Rust — Inline Tests

Embedded in each `.rs` file within `#[cfg(test)] mod tests`:

| Module | Tests | What It Tests |
|---|---|---|
| `interceptor/claude_code_parser` | 60 | JSONL parsing → ParsedEvent, type mapping, token extraction, XML filtering, `ClaudeCodeParser` trait impl, `path_to_agent_id` |
| `interceptor/state_classifier` | 31 | FSM transitions, 300ms debounce (self-transitions only), auto-idle, stale resolution |
| `interceptor/gemini_cli_parser` | 29 | Gemini JSON message parsing, token extraction, `GeminiCliParser` trait impl, `path_to_agent_id`, `resolve_log_dirs` |
| `ipc/commands` | 23 | Tauri commands (get_all_agents, get_agent, get_stats), apply_config, OS info |
| `lib.rs` | 21 | Log-to-agent resolution, cwd matching, cached mapping, stale cleanup, subdirectory matching |
| `discovery/process_scanner` | 18 | Process filtering, TTY check, blocklist, model inference, agent name derivation, parent-child dedup |
| `models/agent_state` | 17 | `Tier::from_model()` for Claude, Gemini, GPT, O-series, serialization |
| `discovery/log_reader` | 16 | `JsonlReader` + `JsonArrayReader`: incremental reading, seeding, file rotation, `can_handle` |
| `interceptor/generic_cli_parser` | 12 | Generic CLI output classification, tool-use/error/complete detection, case-insensitive matching |
| `interceptor/parser_registry` | 10 | Routing: explicit bindings, longest prefix match, auto-detection fallback, `path_to_agent_id` delegation |
| `discovery/agent_registry` | 8 | Register/update/remove, maxAgents limit, active_count excluding Error |
| `ipc/events` | 6 | Event payloads, badge count, camelCase serialization, event name constants |
| `logger` | 5 | `tail_lines` utility (boundary cases, empty content) |
| `discovery/log_watcher` | 3 | File collection, reader filtering, seed behavior |
| `models/bug_report` | 2 | BugReport/OsInfo camelCase serialization |

### Reserved Directories

| Directory | Status | Purpose |
|---|---|---|
| `tests/e2e/` | Empty (`.gitkeep`) | E2E tests (Playwright, planned) |
| `tests/unit/` | Empty (`.gitkeep`) | Reserved |

---

## 4. Vitest Configuration

**File:** `vite.config.ts` → `test` section

### Environment

- **Environment:** `node` (no browser/WebGL)
- **Globals:** `false` (explicit imports of `describe`, `it`, `expect`)
- **Reporter:** `verbose`
- **Coverage provider:** `v8`

### Include Patterns

```
src/**/__tests__/**/*.test.ts   # unit tests colocated with code
tests/**/*.test.ts              # integration tests
```

### Benchmark Patterns

```
tests/benchmarks/**/*.bench.ts  # benchmark files
```

### PixiJS Mocking

Tests run in Node — no WebGL context available. All PixiJS classes (`Container`, `Graphics`, `Text`, `Application`, `AnimatedSprite`) are **mocked** in tests.

**Decoupling pattern:** The `AnimatableSprite` interface decouples `AnimationController` FSM logic from PixiJS. Tests create a mock `AnimatableSprite` implementation with no PixiJS dependency.

```typescript
interface AnimatableSprite {
  alpha: number;
  playAnimation(name: string): void;
  showThinkingIndicator(): void;
  hideThinkingIndicator(): void;
  showToolIcon(tool: "terminal" | "file" | "browser"): void;
  hideToolIcon(): void;
  showSpeechBubble(text: string, durationMs?: number): void;
  hideSpeechBubble(): void;
  showTaskComplete(): void;
  showError(): void;
}
```

### Path Alias

The `$lib` → `./src/lib` alias is available in tests (configured in `vite.config.ts` → `test.alias`).

---

## 5. Coverage Thresholds

| Metric | Threshold |
|---|---|
| Lines | 80% |
| Functions | 80% |
| Branches | 75% |
| Statements | 80% |

**Included files:** `src/lib/**/*.ts`

**Excluded:**
- `src/lib/**/__tests__/**` — test files themselves
- `src/lib/types/**` — type definitions
- `src/lib/**/index.ts` — re-exports
- `src/**/*.svelte` — Svelte components

---

## 6. Rust Tests

### Conventions

- Tests are **inline** — inside each `.rs` file in `mod tests`
- Gate: `#[cfg(test)]`
- I/O tests use `tempfile` for temporary files
- For flaky tests: `--test-threads=1`

### Test Distribution by Module

```
interceptor/       142 tests (54%)
├── claude_code_parser   60
├── state_classifier     31
├── gemini_cli_parser    29
├── generic_cli_parser   12
└── parser_registry      10

discovery/          45 tests (17%)
├── process_scanner      18
├── log_reader           16
├── agent_registry        8
└── log_watcher           3

ipc/                29 tests (11%)
├── commands             23
└── events                6

core/               26 tests (10%)
├── lib.rs               21
└── logger                5

models/             19 tests (7%)
├── agent_state          17
└── bug_report            2
```

### Modules Without Tests

| Module | Reason |
|---|---|
| `models/config.rs` | Contains only data structures and Default impl |

---

## 7. Benchmarks

```bash
npx vitest bench
# or
make bench
```

### Benchmark Files

| File | What It Measures |
|---|---|
| `tests/benchmarks/isometric.bench.ts` | Coordinate conversion (screen ↔ iso) |
| `tests/benchmarks/pathfinder.bench.ts` | A* pathfinding on various map sizes |
| `tests/benchmarks/store-updates.bench.ts` | Store update speed under mass events |

Results are saved to `tests/benchmarks/results.json`.