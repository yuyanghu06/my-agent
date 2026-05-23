#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Ask Claude
# @raycast.mode fullOutput
# @raycast.argument1 { "type": "text", "placeholder": "Ask anything..." }
# @raycast.packageName Personal Agent
# @raycast.icon 🤖

SOCKET="/tmp/claude-agent.sock"

if [ ! -S "$SOCKET" ]; then
  echo "❌ Agent daemon is not running (socket not found at $SOCKET)"
  echo "Try: launchctl start com.yuyang.agent"
  exit 1
fi

QUERY="$1"

/opt/homebrew/bin/node -e '
const net = require("net");
const query = process.argv[1];
const s = net.createConnection("/tmp/claude-agent.sock");
let buf = "";
s.on("connect", () => s.write(JSON.stringify({ query }) + "\n"));
s.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.error) { console.error(msg.error); process.exit(1); }
      if (msg.response) console.log(msg.response);
      if (msg.done) { s.destroy(); process.exit(0); }
    } catch (e) { console.error("Parse error:", e.message); process.exit(1); }
  }
});
s.on("error", (e) => { console.error("Connection failed:", e.message); process.exit(1); });
' "$QUERY"
