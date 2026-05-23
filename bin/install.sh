#!/usr/bin/env bash
# Install the claude-agent LaunchAgent for the current user.
# Generates a plist with absolute paths derived from this repo's location,
# writes it to ~/Library/LaunchAgents, and (re)loads it via launchctl.
#
# Usage:
#   bin/install.sh              # install + load
#   bin/install.sh --uninstall  # unload + remove plist
#   LABEL=com.foo.agent bin/install.sh   # override the launchd label

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${LABEL:-com.$(id -un).agent}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not on PATH. Install Node (brew install node) and retry." >&2
  exit 1
fi

CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "warning: 'claude' CLI not found on PATH. Daemon will fail to spawn it." >&2
fi

uninstall() {
  if [[ -f "$PLIST_PATH" ]]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm "$PLIST_PATH"
    echo "removed $PLIST_PATH"
  else
    echo "no plist at $PLIST_PATH"
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
  exit 0
fi

mkdir -p "$PLIST_DIR" "$REPO_ROOT/logs"

# Build a PATH that covers both Apple Silicon and Intel Homebrew, plus the
# directory containing the resolved node binary (in case it's somewhere odd).
NODE_DIR="$(dirname "$NODE_BIN")"
LAUNCH_PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO_ROOT/daemon.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$REPO_ROOT/logs/launchagent.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO_ROOT/logs/launchagent.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$LAUNCH_PATH</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>CLAUDE_AGENT_ROOT</key>
        <string>$REPO_ROOT</string>
    </dict>
</dict>
</plist>
EOF

echo "wrote $PLIST_PATH"

# Reload: unload first (ignore failure if not loaded), then load fresh.
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "loaded $LABEL"

# Quick smoke check.
sleep 1
if [[ -S /tmp/claude-agent.sock ]]; then
  echo "ok: /tmp/claude-agent.sock is live"
else
  echo "warning: socket not present yet — check $REPO_ROOT/logs/launchagent.log"
fi
