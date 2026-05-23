# Personal Agent — Raycast Extension

Two commands for the local claude-agent daemon:

- **Ask Claude** — type a query in Raycast, hit enter, see the response stream in token-by-token
- **Restart Agent Daemon** — `launchctl stop && start` from a hotkey, for after you add a new MCP server

## Install (development)

```bash
cd ~/Documents/my-agent/raycast
npm install
npm run dev
```

`npm run dev` opens Raycast with the extension loaded. Hot-reloads on save. Quit with Ctrl+C.

To install permanently for daily use:
```bash
npm run build
# then in Raycast: Settings → Extensions → enable "Personal Agent"
```

## Preferences

| Key | Default | What it does |
|---|---|---|
| Daemon Socket Path | `/tmp/claude-agent.sock` | Where the daemon listens |
| LaunchAgent Label | `com.yuyang.agent` | Label `launchctl` uses to stop/start |

Edit them in Raycast: Settings → Extensions → Personal Agent.

## Wire protocol

`Ask Claude` opens a Unix socket connection to the daemon and writes one line:

```json
{"query": "..."}
```

The daemon streams back newline-delimited JSON:

```json
{"chunk": "partial text", "done": false}
{"chunk": "more text",    "done": false}
{"chunk": "final tail",   "response": "full prompt-stripped answer", "done": true}
```

The extension appends each `chunk` to a `<Detail>` markdown view in real time. When `done: true` arrives with a `response` field, it overwrites the displayed text with the canonical version (prompt characters stripped, trimmed).

On error: `{"error": "..."}` — extension shows the error in the Detail view.
