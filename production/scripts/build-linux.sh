#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# OfficeAI — Linux Production Build Script
# Builds: .AppImage + .deb + .rpm
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/production/output/linux"
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
info "OfficeAI Linux build v${VERSION}"

command -v node   >/dev/null 2>&1 || error "Node.js is not installed"
command -v cargo  >/dev/null 2>&1 || error "Rust/Cargo is not installed"
command -v npm    >/dev/null 2>&1 || error "npm is not installed"

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VERSION" -ge 22 ] || error "Node.js >= 22 required (found: $(node -v))"

RUST_VERSION=$(rustc --version | awk '{print $2}')
info "Node.js $(node -v) | Rust $RUST_VERSION"

# ─── Check system dependencies ────────────────────────────────
info "Checking system dependencies..."

MISSING_DEPS=()

check_pkg() {
    if ! dpkg -s "$1" >/dev/null 2>&1 && ! rpm -q "$1" >/dev/null 2>&1; then
        MISSING_DEPS+=("$1")
    fi
}

# Tauri v2 build dependencies
REQUIRED_LIBS=(
    "libwebkit2gtk-4.1-dev"
    "libgtk-3-dev"
    "libayatana-appindicator3-dev"
    "librsvg2-dev"
    "patchelf"
)

for lib in "${REQUIRED_LIBS[@]}"; do
    check_pkg "$lib"
done

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    warn "Missing system packages: ${MISSING_DEPS[*]}"
    echo ""

    if command -v apt-get >/dev/null 2>&1; then
        echo "  Install with:"
        echo "  sudo apt-get install -y ${MISSING_DEPS[*]}"
    elif command -v dnf >/dev/null 2>&1; then
        echo "  Install with:"
        echo "  sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libayatana-appindicator-gtk3-devel librsvg2-devel patchelf"
    elif command -v pacman >/dev/null 2>&1; then
        echo "  Install with:"
        echo "  sudo pacman -S webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg patchelf"
    fi
    echo ""

    if [ "${SKIP_DEP_CHECK:-}" != "1" ]; then
        error "Install missing dependencies and retry (or set SKIP_DEP_CHECK=1 to bypass)"
    fi
fi

# ─── Install dependencies ────────────────────────────────────
info "Installing Node.js dependencies..."
cd "$ROOT_DIR"
npm ci --ignore-scripts 2>/dev/null || npm ci

# ─── Build targets ────────────────────────────────────────────
# Select which formats to build
FORMATS="${BUILD_FORMATS:-all}"

BUILD_ARGS=()
if [ "$FORMATS" = "all" ]; then
    BUILD_ARGS+=(--bundles deb appimage rpm)
    info "Building: .deb + .AppImage + .rpm"
elif [ "$FORMATS" = "deb" ]; then
    BUILD_ARGS+=(--bundles deb)
    info "Building: .deb only"
elif [ "$FORMATS" = "appimage" ]; then
    BUILD_ARGS+=(--bundles appimage)
    info "Building: .AppImage only"
elif [ "$FORMATS" = "rpm" ]; then
    BUILD_ARGS+=(--bundles rpm)
    info "Building: .rpm only"
fi

# ─── Build ────────────────────────────────────────────────────
info "Building production app..."
npx tauri build "${BUILD_ARGS[@]}"

# ─── Collect artifacts ────────────────────────────────────────
info "Collecting build artifacts..."
mkdir -p "$OUTPUT_DIR"

BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle"

# Copy .deb
if ls "$BUNDLE_DIR"/deb/*.deb 1>/dev/null 2>&1; then
    cp "$BUNDLE_DIR"/deb/*.deb "$OUTPUT_DIR/"
    info ".deb package copied"
fi

# Copy .AppImage
if ls "$BUNDLE_DIR"/appimage/*.AppImage 1>/dev/null 2>&1; then
    cp "$BUNDLE_DIR"/appimage/*.AppImage "$OUTPUT_DIR/"
    chmod +x "$OUTPUT_DIR"/*.AppImage
    info ".AppImage copied"
fi

# Copy .rpm
if ls "$BUNDLE_DIR"/rpm/*.rpm 1>/dev/null 2>&1; then
    cp "$BUNDLE_DIR"/rpm/*.rpm "$OUTPUT_DIR/"
    info ".rpm package copied"
fi

# ─── Generate checksums ──────────────────────────────────────
info "Generating checksums..."
cd "$OUTPUT_DIR"
sha256sum * > SHA256SUMS.txt 2>/dev/null || shasum -a 256 * > SHA256SUMS.txt
info "Checksums written to SHA256SUMS.txt"

# ─── Summary ──────────────────────────────────────────────────
info "Linux build complete!"
echo ""
echo "  Artifacts in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR" 2>/dev/null | grep -v "^total"
echo ""
echo "  Install commands:"
echo "    Debian/Ubuntu:  sudo dpkg -i OfficeAI_${VERSION}_amd64.deb"
echo "    Fedora/RHEL:    sudo rpm -i OfficeAI-${VERSION}.x86_64.rpm"
echo "    AppImage:       chmod +x OfficeAI_${VERSION}_amd64.AppImage && ./OfficeAI_${VERSION}_amd64.AppImage"
