# Builder — my-agent

You are Claude Code operating in build mode for Yuyang's personal agent repo. You scaffold, build, and maintain the daemon, the Spotlight Tauri frontend, and surrounding infrastructure. When told to "build the daemon" or "set up the repo", execute all steps autonomously — create files, run installs, register the LaunchAgent, and verify. Do not ask for confirmation on file creation or directory setup. Do confirm before running `launchctl load`.

---

## What You Are Building

A persistent background daemon on Yuyang's Mac plus a Spotlight-style Tauri frontend.

### Daemon
1. Listens on a Unix socket at `/tmp/claude-agent.sock`.
2. Each query spawns a fresh `claude --print --dangerously-skip-permissions --output-format stream-json --include-partial-messages --verbose [--continue] "<query>"` child process.
3. Forwards text deltas, tool-use events, and a final result back to the client over the socket as newline-delimited JSON.
4. Auto-starts at login via a macOS LaunchAgent and auto-respawns if it crashes.
5. Watches `~/Documents/my-agent/MEMORY.md`; if it changes during idle, the next query starts a fresh session (drops `--continue`) so the new memory loads.

### Spotlight (Tauri 2 frontend)
The user-facing client is `~/Documents/my-agent/spotlight/` — a Tauri 2 app that renders a Spotlight-style command bar bound to the daemon's socket. **There is no longer a Raycast extension** — Yuyang built Spotlight to replace it.

- Global hotkey `⌘⇧Space` toggles the window.
- Window is frameless, transparent, accessory-policy (no Dock icon), bottom-aligned visual.
- Frontend talks to Rust commands (`send_query`, `restart_daemon`, `save_image`, `cancel_query`, `interrupt_query`, `open_external`) which proxy to the daemon socket / system.
- Markdown is rendered via `markdown-it`.
- Slash command palette (`/restart`, `/clear`, `/hide`).

---

## Repo Layout

```
~/Documents/my-agent/
├── CLAUDE.md                          # Agent runtime context — DO NOT MODIFY
├── MEMORY.md                          # Durable facts — agent-edited at runtime
├── daemon.js                          # The socket daemon
├── com.yuyang.agent.plist             # LaunchAgent
├── package.json
├── logs/                              # daemon.log, launchagent.log
├── build/
│   └── CLAUDE.md                      # This file
└── spotlight/                         # Tauri 2 frontend
    ├── index.html
    ├── src/
    │   ├── main.ts                    # send query, render markdown, palette, attachments
    │   └── style.css
    └── src-tauri/
        ├── Cargo.toml
        ├── tauri.conf.json
        ├── capabilities/default.json
        └── src/main.rs                # Unix-socket client, hotkey, image save
```

---

## Tech Stack

- **Daemon**: Node 18+ ESM, stdlib only (`net`, `child_process`, `fs`).
- **Spotlight**: Tauri 2 + Vite + TypeScript, `markdown-it`, `@tauri-apps/plugin-global-shortcut`, `@tauri-apps/plugin-window-state`.
- **Launcher**: macOS LaunchAgent.
- **Logging**: ISO-timestamped append to `~/Documents/my-agent/logs/daemon.log`.

No npm dependencies on the daemon side unless stdlib genuinely cannot do the job.

---

## daemon.js Spec (current)

### Startup
1. Create `~/Documents/my-agent/logs/`.
2. Delete stale socket at `/tmp/claude-agent.sock` if present.
3. Listen on the socket, `chmod 0600`.

### Message protocol

Client → daemon (newline-delimited JSON):

```json
{"query": "..."}                       // start a new query
{"cancel": true}                       // SIGTERM the in-flight child for this connection
{"query": "...", "interrupt": true}    // cancel current + start fresh with new query
```

Daemon → client:

```json
{"chunk": "...", "done": false}                       // text delta
{"tool": "mcp__name__action", "label": "...", "done": false}  // tool-use event
{"chunk": "", "response": "...", "done": true}        // terminal
{"error": "..."}                                      // failure
```

### Per-query execution
1. Spawn `claude --print --dangerously-skip-permissions --output-format stream-json --include-partial-messages --verbose [--continue] "<query>"` with cwd `~/Documents/my-agent/`.
2. Parse stream-json events:
   - `stream_event.content_block_delta.text_delta` → emit `{chunk}`.
   - `stream_event.content_block_start` of type `tool_use` → buffer.
   - `stream_event.content_block_delta.input_json_delta` → buffer input.
   - `stream_event.content_block_stop` → emit `{tool, label}` with extracted human label.
   - `result` → emit `{chunk:"", response, done:true}` (or `{error}` if `is_error`).
3. On exit code 0 with no result event → fall back to collected text.

### Timeout & memory refresh
- Per-query timeout: 600s (long tool chains are real; below this we silently dropped useful work).
- Memory: `fs.watch(MEMORY.md)` flips `memoryDirty`. At query start, if `memoryDirty && idleElapsed > 5min`, omit `--continue` and clear the dirty flag.

### Cancel / interrupt
- `{cancel:true}` on an active connection: SIGTERM the child for that connection and emit `{error: "Cancelled"}` then close.
- `{query, interrupt:true}` on a connection that has an in-flight query: SIGTERM the current child, then immediately start the new query (using `--continue` so claude sees the partial assistant turn already on disk).

### Concurrency
One query per connection. Multiple connections queue at the daemon level (FIFO).

---

## Spotlight Spec (current)

### Window
Frameless, transparent, `macOSPrivateApi: true`, accessory activation policy, `alwaysOnTop: false`, `shadow: true`. Width 640, min height 48, max height 720.

### Composer
- Auto-growing `<textarea>` (wraps long lines, capped height).
- `Enter` sends; `Shift+Enter` newline.
- Slash commands: typing `/` opens a palette overlay (`/restart`, `/clear`, `/hide`).
- Pasted images → saved to `/tmp/spotlight-images/`, rendered as raw thumbnails (no filename) in the input.
- Pasted text > 280 chars → collapses to a `PASTED` chip; click to expand/edit.

### Streaming
- Each user→assistant exchange is its own `Turn` block in the scrollback.
- Tool calls render as inline pill chips between text segments.
- Anthropic-style typing dots while waiting for first delta.
- Sticky-bottom autoscroll: only follows if user is already at bottom; if user scrolls up, position stays fixed.
- Mid-stream send: cancels current claude child and injects the new query as a fresh continuation (`interrupt_query` Rust command).

### Inline reply
Each completed assistant turn has a `↩ Reply` affordance. Clicking it opens a small composer attached to that turn with two send modes:
1. **Inject** — sends as the next main-stream turn, with a quote of the source assistant message prepended for context.
2. **Side-chat** — opens a floating bubble anchored to the source turn; queries inside the bubble are sent as one-off questions and rendered separately. They still flow through the same daemon session (claude `--continue`) so context is shared, but are visually segregated and don't disrupt the main scroll.

### Keys
| Key | Action |
|---|---|
| `⌘⇧Space` | Toggle window |
| `Enter` | Send |
| `Shift+Enter` | Newline |
| `Esc` (with running stream) | Cancel current turn, keep history |
| `Esc` (idle, has input) | Clear input |
| `Esc` (idle, empty) | Hide window |
| `⌘K` | Clear conversation |
| `⌘⇧R` | Restart daemon |
| `⌘`+drag anywhere | Reposition window |

### Links
All `<a>` clicks in the response area are intercepted and routed through the Tauri shell-open command so they launch in the user's default browser instead of replacing the webview.

### Resize
Window auto-fits content via `ResizeObserver` on the response pane. User-resizes are respected as a new ceiling. fitWindow uses `scrollHeight` of the content (not `offsetHeight`) so streaming never clips, and never lets `userMaxHeight` shrink below the streamed content.

---

## com.yuyang.agent.plist Spec

```
Label:             com.yuyang.agent
ProgramArguments:  [<which node>, ~/Documents/my-agent/daemon.js]
WorkingDirectory:  ~/Documents/my-agent
RunAtLoad:         true
KeepAlive:         true
StandardOutPath:   ~/Documents/my-agent/logs/launchagent.log
StandardErrorPath: ~/Documents/my-agent/logs/launchagent.log
EnvironmentVariables:
  PATH: /usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin
  HOME: /Users/yuyang
```

Detect node path via `which node` and use that.

---

## Common Maintenance Tasks

**Restart daemon:**
```bash
launchctl stop com.yuyang.agent && launchctl start com.yuyang.agent
```

**Spotlight dev:**
```bash
cd ~/Documents/my-agent/spotlight && npm run tauri dev
```

**Spotlight build:**
```bash
cd ~/Documents/my-agent/spotlight && npm run tauri build
# Output: src-tauri/target/release/bundle/macos/Spotlight.app
```

**View logs:**
```bash
tail -f ~/Documents/my-agent/logs/daemon.log
```

**Smoke test:**
```bash
node -e "
const net = require('net');
const s = net.createConnection('/tmp/claude-agent.sock', () => {
  s.write(JSON.stringify({query:'say hello'}) + '\n');
});
s.on('data', d => { console.log(d.toString()); });
"
```

**Add a new MCP server:**
```bash
claude mcp add --scope global <name> <args>
launchctl stop com.yuyang.agent && launchctl start com.yuyang.agent
```

---

## What Not To Do

- Do not modify `~/Documents/my-agent/CLAUDE.md` — that is the agent's runtime context.
- Do not bring the Raycast extension back — Spotlight replaces it.
- Do not add HTTP or external ports — Unix socket only, local trust boundary.
- Do not add npm dependencies unless Node stdlib genuinely cannot do the job.
- Do not add authentication to the socket — local only.
- Do not use a long-lived `claude` REPL via piped stdio — claude detects non-TTY and exits. Per-query `--print` invocations with `--continue` is the only working model.
