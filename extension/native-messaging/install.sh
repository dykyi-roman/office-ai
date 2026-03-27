#!/usr/bin/env bash
# Native messaging host installation script for OfficeAI.
#
# Installs the host manifest to the correct Chrome native messaging host
# directory for the current platform (macOS, Linux).
#
# Usage:
#   ./install.sh <extension-id>
#
# Example:
#   ./install.sh abcdefghijklmnopabcdefghijklmnop
#
# After installation, the Chrome extension with the given ID will be
# permitted to communicate with the native host.

set -euo pipefail

# ============================================================================
# Arguments
# ============================================================================

EXTENSION_ID="${1:-}"

if [ -z "$EXTENSION_ID" ]; then
  echo "Usage: $0 <extension-id>"
  echo ""
  echo "Find your extension ID at chrome://extensions (enable Developer mode)"
  exit 1
fi

# ============================================================================
# Paths
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="${SCRIPT_DIR}/host.cjs"
MANIFEST_TEMPLATE="${SCRIPT_DIR}/office_ai.json"
MANIFEST_NAME="office_ai.json"
HOST_NAME="office_ai"

# Detect OS and set the native messaging host directory
case "$(uname -s)" in
  Darwin)
    # macOS — Chrome
    CHROME_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    # macOS — Chromium
    CHROMIUM_DIR="${HOME}/Library/Application Support/Chromium/NativeMessagingHosts"
    ;;
  Linux)
    # Linux — Chrome
    CHROME_DIR="${HOME}/.config/google-chrome/NativeMessagingHosts"
    # Linux — Chromium
    CHROMIUM_DIR="${HOME}/.config/chromium/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported platform: $(uname -s)"
    echo "On Windows, register the manifest at:"
    echo "  HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}"
    exit 1
    ;;
esac

# ============================================================================
# Validate host script
# ============================================================================

if [ ! -f "$HOST_JS" ]; then
  echo "Error: host.js not found at: $HOST_JS"
  exit 1
fi

# Make host executable
chmod +x "$HOST_JS"

# ============================================================================
# Check Node.js is available
# ============================================================================

NODE_PATH="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_PATH" ]; then
  echo "Error: Node.js not found. Please install Node.js (https://nodejs.org)"
  exit 1
fi
echo "Using Node.js: $NODE_PATH"

# ============================================================================
# Generate wrapper script
# ============================================================================
# Chrome native messaging requires an executable script, not a .js file directly.
# We create a small wrapper that invokes node with the host script.

WRAPPER_PATH="${SCRIPT_DIR}/office-ai-host"

cat > "$WRAPPER_PATH" << EOF
#!/usr/bin/env bash
# Auto-generated wrapper for OfficeAI native messaging host
exec "${NODE_PATH}" "${HOST_JS}" "\$@"
EOF

chmod +x "$WRAPPER_PATH"
echo "Created wrapper: $WRAPPER_PATH"

# ============================================================================
# Generate manifest with real paths and extension ID
# ============================================================================

GENERATED_MANIFEST="${SCRIPT_DIR}/${MANIFEST_NAME}"

cat > "$GENERATED_MANIFEST" << EOF
{
  "name": "${HOST_NAME}",
  "description": "OfficeAI native messaging host — bridges the Chrome extension to the Tauri desktop app",
  "path": "${WRAPPER_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF

echo "Generated manifest: $GENERATED_MANIFEST"

# ============================================================================
# Install manifest for Chrome
# ============================================================================

install_manifest() {
  local target_dir="$1"
  local browser_name="$2"

  if [ ! -d "$target_dir" ]; then
    echo "Creating directory: $target_dir"
    mkdir -p "$target_dir"
  fi

  cp "$GENERATED_MANIFEST" "${target_dir}/${MANIFEST_NAME}"
  echo "Installed for ${browser_name}: ${target_dir}/${MANIFEST_NAME}"
}

install_manifest "$CHROME_DIR" "Google Chrome"

# Also install for Chromium if its config dir exists
if [ -d "$(dirname "$CHROMIUM_DIR")" ]; then
  install_manifest "$CHROMIUM_DIR" "Chromium"
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "Installation complete."
echo ""
echo "Extension ID: ${EXTENSION_ID}"
echo "Native host:  ${WRAPPER_PATH}"
echo ""
echo "To verify, open Chrome and go to:"
echo "  chrome://extensions -> OfficeAI -> Details -> Native Messaging"
echo ""
echo "Or test manually:"
echo "  echo '{}' | ${WRAPPER_PATH}"
