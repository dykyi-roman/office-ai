# Contributing to OfficeAI

Thank you for your interest in contributing! This guide will help you get started.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Project Structure](#project-structure)
- [Architecture Overview](#architecture-overview)
- [Commit Messages](#commit-messages)
- [Code Style](#code-style)
- [Type Synchronization](#type-synchronization)
- [Testing](#testing)
- [Adding UI Strings (i18n)](#adding-ui-strings-i18n)
- [Documentation](#documentation)
- [Available Make Commands](#available-make-commands)
- [Reporting Issues](#reporting-issues)
- [License](#license)

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Rust](https://rustup.rs/) >= 1.75
- System dependencies for [Tauri v2](https://tauri.app/start/prerequisites/)

### Setup

1. **Fork** the repository on [GitHub](https://github.com/dykyi-roman/office-ai)
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/office-ai.git
   cd office-ai
   ```
3. **Install** dependencies:
   ```bash
   make install    # npm ci + cargo fetch
   ```
4. **Run** in dev mode:
   ```bash
   make dev        # Tauri + Vite with hot reload
   ```

The app opens in a native 1280x800 window. The Rust backend automatically starts scanning processes and logs.

---

## Development Workflow

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature main
   ```
2. Make your changes
3. Run checks before committing:
   ```bash
   make check      # svelte-check + clippy + fmt --check
   make test-all   # TypeScript + Rust tests
   ```
4. Commit using [Conventional Commits](#commit-messages)
5. Push and open a Pull Request against `main`

---

## Project Structure

```
src/
├── lib/
│   ├── types/          # TypeScript types (source of truth for IPC)
│   ├── stores/         # Svelte 5 state stores (.svelte.ts)
│   ├── renderer/       # PixiJS v8 isometric renderer
│   ├── ui/             # Svelte overlay components
│   ├── i18n/           # Internationalization (11 locales)
│   └── sound/          # Sound engine
src-tauri/
├── src/
│   ├── discovery/      # Process scanner, log watcher, agent registry
│   ├── interceptor/    # Log parsers, state classifier FSM
│   ├── ipc/            # Tauri event emitters + invoke commands
│   ├── models/         # AgentState, AppConfig, BugReport
│   ├── lib.rs          # Async Tokio tasks wiring
│   ├── main.rs         # Entry point
│   ├── logger.rs       # Logging setup
│   └── error.rs        # Error types
tests/
├── integration/        # Frontend integration tests
├── e2e/                # E2E tests (Playwright)
└── benchmarks/         # Performance benchmarks (vitest bench)
scripts/                # Asset generation (sprites, tiles, effects)
docs/                   # Architecture, configuration, testing docs
```

---

## Architecture Overview

```
OS Processes (sysinfo)          Agent log files
        │                                │
        ▼                                ▼
  Process Scanner (2s)          Log Watcher (500ms)
        │                                │
        └──────────┬─────────────────────┘
                   ▼
           Agent Registry ──► Tauri IPC Events
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
   Svelte UI             PixiJS Renderer
   (overlay)             (isometric scene)
```

**Rust backend** — five async Tokio tasks communicating via `mpsc` channels:
1. Process Scanner — discovers AI agents via OS processes
2. Log Watcher — reads agent JSONL log files
3. Scanner Consumer — enforces `maxAgents`, updates registry
4. Log Consumer — parses logs, classifies state (FSM with 300ms debounce)
5. Auto-idle Consumer — transitions agents to idle after timeout

**Frontend** — Svelte 5 stores subscribe to Tauri IPC events and drive both the overlay UI and the PixiJS isometric renderer.

For full details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
feat(scope): add new feature
fix(scope): fix a bug
test: add or update tests
refactor(scope): restructure code without behavior change
docs: update documentation
chore: maintenance tasks
```

**Scopes:** `discovery`, `renderer`, `ui`, `ipc`, `i18n`, `sound`, `interceptor`, `models`, `stores`

---

## Code Style

### TypeScript

- Strict mode, no `any`
- camelCase for variables/functions, PascalCase for types/classes
- Svelte 5 runes syntax (`$state`, `$derived`, `$effect`)
- All UI strings via `t("key")` — never hardcode user-visible text
- Import types from `src/lib/types/`, never redefine

### Rust

- `cargo clippy -- -D warnings` must pass with zero warnings
- `cargo fmt` before every commit
- snake_case for all identifiers
- All structs derive `Serialize, Deserialize, Clone, Debug`
- All structs: `#[serde(rename_all = "camelCase")]`
- All enums: `#[serde(rename_all = "snake_case")]`
- Async operations via Tokio

---

## Type Synchronization

TypeScript types in `src/lib/types/` are the **source of truth**. Rust structs in `src-tauri/src/models/` must mirror them exactly.

When changing a type, update in this order:

1. `src/lib/types/` — TypeScript definitions
2. `src-tauri/src/models/` — Rust structs
3. `src-tauri/src/ipc/` — Tauri commands/events (if affected)
4. Frontend stores / renderer / UI (if affected)

> **Exception:** `models/bug_report.rs` structs are Rust-only (written to file, not sent via IPC).

---

## Testing

### Overview

| Category       | Framework   | Location                                    |
|----------------|-------------|---------------------------------------------|
| **TypeScript** | Vitest      | `src/lib/**/__tests__/` (colocated)         |
| **Rust**       | cargo test  | Inline `#[cfg(test)] mod tests` in `.rs`    |
| **Integration**| Vitest      | `tests/integration/`                        |
| **E2E**        | Playwright  | `tests/e2e/`                                |
| **Benchmarks** | vitest bench| `tests/benchmarks/`                         |

### Commands

```bash
make test-js     # TypeScript tests only
make test-rust   # Rust tests only
make test-all    # All tests (TS + Rust)
make bench       # Performance benchmarks
```

### Key Rules

- **Environment:** Node (no browser/WebGL) — all PixiJS classes must be mocked
- **Path alias:** `$lib` → `./src/lib` (configured in `vite.config.ts`)
- **Coverage thresholds:** lines 80%, functions 80%, branches 75%, statements 80%

For full testing guide, see [docs/TESTING.md](docs/TESTING.md).

---

## Adding UI Strings (i18n)

The project supports 11 locales: `ar`, `de`, `en`, `es`, `fr`, `hi`, `it`, `ja`, `pt`, `ru`, `zh`.

When adding any user-visible text:

1. Add the key to **all 11 locales** in `src/lib/i18n/translations.ts`
2. Use `t("key.name")` in Svelte components
3. The `TranslationKey` type provides compile-time safety — missing keys cause TS errors

---

## Documentation

After every code change, update the relevant docs:

| Document                                  | Content                                          |
|-------------------------------------------|--------------------------------------------------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)   | System design, data structures, algorithms       |
| [FRONTEND.md](docs/FRONTEND.md)           | Svelte 5, PixiJS v8, stores, UI                  |
| [BACKEND.md](docs/BACKEND.md)             | Rust backend — process scanner, log parser, IPC  |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | All settings (defaults, behavior)                |
| [TESTING.md](docs/TESTING.md)             | Test structure, commands, coverage, CI/CD        |

---

## Available Make Commands

| Command              | Description                                      |
|----------------------|--------------------------------------------------|
| `make install`       | Install all dependencies (npm + cargo)           |
| `make dev`           | Full Tauri + Vite dev server with hot reload     |
| `make build`         | Production build (DMG / AppImage / MSI)          |
| `make build-debug`   | Debug build (faster, no optimizations)           |
| `make build-frontend`| Build frontend only (to `dist/`)                 |
| `make check`         | svelte-check + clippy + fmt --check              |
| `make clippy`        | Rust linter only (warnings = errors)             |
| `make fmt`           | Auto-format Rust code                            |
| `make lint`          | Svelte type checker only                         |
| `make test-js`       | TypeScript tests (Vitest)                        |
| `make test-rust`     | Rust tests                                       |
| `make test-all`      | All tests (TS + Rust)                            |
| `make test-watch`    | TypeScript tests in watch mode                   |
| `make bench`         | Performance benchmarks                           |
| `make assets`        | Regenerate all visual assets (sprites + tiles + effects) |
| `make icons`         | Generate Tauri app icons from source image       |
| `make clean`         | Remove `dist/` + `cargo clean`                   |
| `make clean-all`     | Remove build artifacts + `node_modules`          |

---

## Reporting Issues

- Use [GitHub Issues](https://github.com/dykyi-roman/office-ai/issues)
- Include steps to reproduce, expected vs actual behavior
- Attach the **Bug Report** JSON file if relevant (Settings → Bug Report in the app)
- Attach logs from `logs/app.log` — log prefixes: `[SCANNER]`, `[LOG_RX]`, `[LOG_PARSE]`, `[LOG_CLASSIFY]`, `[LOG_UPDATE]`, `[TIER]`, `[AUTO_IDLE]`, `[BADGE]`, `[CONFIG]`

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
