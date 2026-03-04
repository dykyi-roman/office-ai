.PHONY: help dev build run clean install check test test-watch test-rust test-all bench lint fmt assets icons

# Default target
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Setup ────────────────────────────────────────────────────────────────────

install: ## Install all dependencies (npm + cargo)
	npm ci
	cd src-tauri && cargo fetch

icons: ## Generate Tauri app icons from a source image (requires tauri-cli)
	npx tauri icon src-tauri/icons/icon.png

# ─── Development ──────────────────────────────────────────────────────────────

dev: ## Start dev mode (Vite + Tauri window with hot reload)
	npm run tauri:dev

# ─── Build ────────────────────────────────────────────────────────────────────

build: ## Build production app (.dmg on macOS, .AppImage on Linux, .msi on Windows)
	npm run tauri:build

build-debug: ## Build debug version (faster, no optimizations)
	cd src-tauri && cargo build

build-frontend: ## Build frontend only (to dist/)
	npm run build

# ─── Testing ──────────────────────────────────────────────────────────────────

test-js: ## Run TypeScript unit tests (vitest)
	npx vitest run

test-watch: ## Run TypeScript tests in watch mode
	npx vitest --watch

test-rust: ## Run Rust unit tests
	cd src-tauri && cargo test

test-all: ## Run all tests (TypeScript + Rust)
	npx vitest run
	cd src-tauri && cargo test

bench: ## Run performance benchmarks
	npx vitest bench

# ─── Code Quality ─────────────────────────────────────────────────────────────

check: ## Run all checks (types + clippy + fmt)
	npx svelte-check --tsconfig ./tsconfig.json
	cd src-tauri && cargo clippy -- -D warnings
	cd src-tauri && cargo fmt --check

lint: ## Run Svelte type checker
	npx svelte-check --tsconfig ./tsconfig.json

fmt: ## Format Rust code
	cd src-tauri && cargo fmt

clippy: ## Run Rust linter (warnings as errors)
	cd src-tauri && cargo clippy -- -D warnings

# ─── Assets ───────────────────────────────────────────────────────────────────

assets: ## Generate all visual assets (sprites + tiles + effects)
	npm run generate:all

sprites: ## Generate agent spritesheets only
	npm run generate:sprites

# ─── Cleanup ──────────────────────────────────────────────────────────────────

clean: ## Remove build artifacts
	rm -rf dist
	cd src-tauri && cargo clean

clean-all: clean ## Remove build artifacts + node_modules
	rm -rf node_modules
