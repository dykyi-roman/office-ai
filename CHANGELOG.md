# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-08

### Added
- **Gemini CLI Support** — Full process detection and log parsing for Gemini CLI sessions.
- **Multi-Agent Disambiguation** — Improved logic for correlating log files with specific agent processes.
- **Debug Mode** — New configuration option for verbose diagnostic logging and troubleshooting.
- **Cancel Status** — Cancellations are detected in real-time if you interrupt an agent.
- **Automatic Cleanup** — Sub-agents are now automatically cleared on new user prompts or terminal states (Idle, Error, Task Complete).

### Changed
- **Enhanced Process Scanning** — More robust detection of CLI agents using structured system process data.
- **Visual Consistency** — Updated agent tier colors to match the UI theme across all components.
- **Improved Config Migration** — Automated injection of new default patterns and log roots for existing configurations.

### Fixed
- Stale sub-agents no longer persist across different user prompts.

## [0.1.0] - 2026-03-03

### Added
- **Core Architecture** — Initial release featuring Tauri v2 (Rust backend), Svelte 5 (frontend), and PixiJS v8 (isometric renderer).
- **Agent Detection** — Automated scanning for Claude Code CLI processes and real-time log monitoring.
- **Isometric Office Map** — High-performance 2D engine with A* pathfinding, desk management, and smooth camera controls.
- **Agent State Tracking** — Real-time visualization of agent statuses: Thinking, Responding, Tool Use, Task Complete, and Error.
- **Interactive UI Overlay** — Feature-rich interface including Agent Sidebar, Settings Panel, Metrics, and a Live Activity Log.
- **Sound Engine** — Immersive audio feedback mapped to agent actions and state changes.
- **Internationalization** — Support for 11 languages (Arabic, German, English, Spanish, French, Hindi, Italian, Japanese, Portuguese, Russian, Chinese).
- **Persistence & Config** — Robust settings management with automatic synchronization between backend and frontend.
- **Diagnostic Tools** — Built-in bug report generator and extensive documentation.
