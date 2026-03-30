#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# OfficeAI — macOS Production Build Script
# Builds: .dmg + .app bundle (universal binary: x86_64 + aarch64)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/production/output/macos"
VERSION=$(grep '"version"' "$ROOT_DIR/package.json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ─── Preflight checks ────────────────────────────────────────
info "OfficeAI macOS build v${VERSION}"

command -v node   >/dev/null 2>&1 || error "Node.js is not installed"
command -v cargo  >/dev/null 2>&1 || error "Rust/Cargo is not installed"
command -v npm    >/dev/null 2>&1 || error "npm is not installed"

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VERSION" -ge 22 ] || error "Node.js >= 22 required (found: $(node -v))"

RUST_VERSION=$(rustc --version | awk '{print $2}')
info "Node.js $(node -v) | Rust $RUST_VERSION"

# ─── Check Xcode CLI tools ───────────────────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
    error "Xcode Command Line Tools not installed. Run: xcode-select --install"
fi

# ─── Optional: code signing ──────────────────────────────────
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
APPLE_ID="${APPLE_ID:-}"
APPLE_PASSWORD="${APPLE_PASSWORD:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"

if [ -n "$SIGN_IDENTITY" ]; then
    info "Code signing with identity: $SIGN_IDENTITY"
    export APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY"
else
    warn "No APPLE_SIGNING_IDENTITY set — building unsigned"
fi

# ─── Install dependencies ────────────────────────────────────
info "Installing dependencies..."
cd "$ROOT_DIR"
npm ci --ignore-scripts 2>/dev/null || npm ci

# ─── Add Rust targets for universal binary ────────────────────
info "Ensuring Rust targets..."
rustup target add aarch64-apple-darwin 2>/dev/null || true
rustup target add x86_64-apple-darwin  2>/dev/null || true

# ─── Build ────────────────────────────────────────────────────
info "Building production app..."

BUILD_ARGS=()

# Universal binary (both architectures)
ARCH="${BUILD_ARCH:-universal}"
if [ "$ARCH" = "universal" ]; then
    BUILD_ARGS+=(--target universal-apple-darwin)
    info "Building universal binary (x86_64 + aarch64)"
elif [ "$ARCH" = "arm64" ]; then
    BUILD_ARGS+=(--target aarch64-apple-darwin)
    info "Building for Apple Silicon only"
elif [ "$ARCH" = "x86_64" ]; then
    BUILD_ARGS+=(--target x86_64-apple-darwin)
    info "Building for Intel only"
fi

npx tauri build "${BUILD_ARGS[@]}"

# ─── Collect artifacts ────────────────────────────────────────
info "Collecting build artifacts..."
mkdir -p "$OUTPUT_DIR"

# Find built bundles
BUNDLE_DIR="$ROOT_DIR/src-tauri/target"
if [ "$ARCH" = "universal" ]; then
    BUNDLE_DIR="$BUNDLE_DIR/universal-apple-darwin/release/bundle"
elif [ "$ARCH" = "arm64" ]; then
    BUNDLE_DIR="$BUNDLE_DIR/aarch64-apple-darwin/release/bundle"
elif [ "$ARCH" = "x86_64" ]; then
    BUNDLE_DIR="$BUNDLE_DIR/x86_64-apple-darwin/release/bundle"
else
    BUNDLE_DIR="$BUNDLE_DIR/release/bundle"
fi

# Copy DMG
if ls "$BUNDLE_DIR"/dmg/*.dmg 1>/dev/null 2>&1; then
    cp "$BUNDLE_DIR"/dmg/*.dmg "$OUTPUT_DIR/"
    info "DMG copied to $OUTPUT_DIR/"
fi

# Copy .app bundle
if ls "$BUNDLE_DIR"/macos/*.app 1>/dev/null 2>&1; then
    cp -R "$BUNDLE_DIR"/macos/*.app "$OUTPUT_DIR/"
    info ".app bundle copied to $OUTPUT_DIR/"
fi

# ─── Notarization (optional) ─────────────────────────────────
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
    DMG_FILE=$(ls "$OUTPUT_DIR"/*.dmg 2>/dev/null | head -1)
    if [ -n "$DMG_FILE" ]; then
        info "Submitting for notarization..."
        xcrun notarytool submit "$DMG_FILE" \
            --apple-id "$APPLE_ID" \
            --password "$APPLE_PASSWORD" \
            --team-id "$APPLE_TEAM_ID" \
            --wait

        info "Stapling notarization ticket..."
        xcrun stapler staple "$DMG_FILE"
        info "Notarization complete"
    fi
else
    warn "Skipping notarization (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID not set)"
fi

# ─── Summary ──────────────────────────────────────────────────
info "macOS build complete!"
echo ""
echo "  Artifacts in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR" 2>/dev/null | grep -v "^total"
echo ""
info "To install: open the .dmg and drag OfficeAI to Applications"
