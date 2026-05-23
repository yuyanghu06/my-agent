# my-agent

A persistent personal agent on macOS. A long-lived `claude` CLI session sits behind a Unix socket, so a global hotkey (Spotlight-style Tauri app, Raycast, or any local script) can ask it questions without ever opening a terminal.

```
Spotlight.app ──▶                                       ┌── MCP servers
Raycast ext   ──▶  /tmp/claude-agent.sock  ──▶ daemon.js ──▶ claude (child)
nc -U         ──▶                                       └── MEMORY.md / CLAUDE.md
```

The daemon, MCPs, and memory layer are shared across all clients.

## Repo layout

```
my-agent/
├── CLAUDE.md                 # Runtime context (identity, routing rules, behavior)
├── MEMORY.md                 # Mutable durable memory — agent appends here
├── daemon.js                 # The persistent socket server
├── bin/
│   └── install.sh            # Generates the LaunchAgent plist and loads it
├── raycast/                  # Raycast extension client
├── spotlight/                # Tauri 2 Spotlight-style client (global hotkey)
├── spotlight-sessions/       # Persisted session history + settings (tracked)
├── spotlight-images/         # Captured screenshots (gitignored)
├── spotlight-clips/          # Audio/video clips (gitignored)
├── spotlight-files/          # Uploaded files (gitignored)
├── build/                    # "Builder Claude" workspace
└── logs/                     # daemon.log + launchagent.log (gitignored)
```

## Prerequisites

- macOS (tested on Apple Silicon, paths handle Intel too)
- Node 18+ (`brew install node`)
- The `claude` CLI on PATH (`npm i -g @anthropic-ai/claude-code` or equivalent)
- Rust toolchain — only if you want to build the Spotlight client (`brew install rustup-init && rustup-init`)

## Install

```bash
git clone <repo> ~/Documents/my-agent
cd ~/Documents/my-agent
bin/install.sh
```

That script:
1. Resolves the absolute paths from the repo's location (no hardcoded usernames).
2. Writes `~/Library/LaunchAgents/com.<user>.agent.plist`.
3. `launchctl load`s it. The daemon starts immediately and on every login.
4. Smoke-checks `/tmp/claude-agent.sock`.

Override the launchd label with `LABEL=com.foo.agent bin/install.sh`.

Tear down with `bin/install.sh --uninstall`.

### Install the Spotlight client

```bash
cd spotlight
npm install
npm run tauri build
open src-tauri/target/release/bundle/macos/Spotlight.app   # or drag to /Applications
```

Add to **System Settings → General → Login Items** so it's always available.
Default global hotkey: **⌘⇧Space**. Edit `spotlight/src-tauri/src/main.rs` to change.

### Install the Raycast extension

```bash
cd raycast
npm install
npm run dev    # imports the extension into Raycast
```

## Usage

| Client | How |
|---|---|
| Spotlight | ⌘⇧Space → type → ↵. ⌘⇧R to restart daemon. Esc to hide. |
| Raycast | "Ask Claude" command. "Restart Agent Daemon" command. |
| CLI | `echo '{"query":"what is on my calendar today"}' \| nc -U /tmp/claude-agent.sock` |

Tail logs:
```bash
tail -f logs/daemon.log
```

Restart manually (e.g., after registering a new MCP server):
```bash
launchctl stop com.$(id -un).agent && launchctl start com.$(id -un).agent
```

## How it works

1. Login → launchd loads the plist → spawns `node daemon.js` with `KeepAlive=true`.
2. `daemon.js` opens `/tmp/claude-agent.sock` (mode 0600, local-only) and waits.
3. On each query, it spawns `claude --print --output-format stream-json --continue <query>` and streams the response back as newline-delimited JSON.
4. Socket protocol — clients write one JSON message per line:
   - `{"query":"..."}` — ask
   - `{"fresh":true}` — drop `--continue`, start a new claude session
   - `{"resume":"<uuid>"}` — `--resume <uuid>` for the next query
   - `{"cancel":true}` / `{"interrupt":true}` — kill the in-flight child
5. Responses stream back as:
   - `{"session_id":"...","done":false}` once at start
   - `{"chunk":"...","done":false}` for each text delta
   - `{"tool":"name","label":"...","done":false}` per tool call
   - `{"response":"...","done":true}` final
6. If `claude` crashes, the daemon respawns it. If the daemon crashes, launchd restarts it.

## Memory model

Two files load into the agent's context every session:

- **`CLAUDE.md`** — static identity, routing rules, behavior. Edit manually.
- **`MEMORY.md`** — durable facts. The agent appends here when you say "remember X". CLAUDE.md pulls it in via `@MEMORY.md`.

The daemon watches `MEMORY.md`. When it changes AND no queries have arrived for 5 minutes, the next query starts a fresh claude session (drops `--continue`) so the new memory is loaded. Want it sooner? Hit ⌘⇧R in Spotlight to force a restart.

## Adding MCP servers

```bash
claude mcp add --scope user <name> -- <command> <args...>
launchctl stop com.$(id -un).agent && launchctl start com.$(id -un).agent
```

The restart is required so the daemon's child claude picks up the new tool list.

## Path/socket overrides

`daemon.js` honors two env vars (set them in the plist's `EnvironmentVariables` block if needed):

| Env var | Default | Purpose |
|---|---|---|
| `CLAUDE_AGENT_ROOT` | Directory of `daemon.js` | Where to read CLAUDE.md, MEMORY.md, write logs |
| `CLAUDE_AGENT_SOCKET` | `/tmp/claude-agent.sock` | Socket path. Override for multi-user machines. |

## Two CLAUDE.mds

| File | Read by | Purpose |
|---|---|---|
| `CLAUDE.md` (root) | The runtime agent | Personal context: calendars, accounts, preferences |
| `build/CLAUDE.md` | "Builder Claude" — sessions started inside `build/` | How to scaffold/modify the daemon, plist, scripts |

The runtime agent never reads `build/CLAUDE.md`. Builder Claude must not touch the root `CLAUDE.md` unless explicitly asked.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Client says "socket not found" | Daemon not running | `launchctl list \| grep agent` — if missing, re-run `bin/install.sh` |
| Query times out after 10min | claude hung | Check `logs/daemon.log`; restart with ⌘⇧R or `launchctl stop/start` |
| Daemon respawns in a loop | `node` or `claude` not in plist's PATH | Re-run `bin/install.sh` so it picks up your current `command -v node` |
| MCP tool not visible | Daemon hasn't restarted since `mcp add` | `launchctl stop ... && launchctl start ...` |

## Not committed

- `~/.claude/creds-*.json` — per-account OAuth credentials, machine-bound
- `logs/`
- `spotlight-images/`, `spotlight-clips/`, `spotlight-files/` — runtime user data
- Generated plists (`com.*.agent.plist`)
- `node_modules/`, `spotlight/src-tauri/target/`
