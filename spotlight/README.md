# Spotlight — Personal Agent Frontend

A Tauri 2 macOS app that summons a Spotlight-style search bar bound to your `claude-agent` daemon. Type a question, see the response stream in below in clean markdown. Bottom-anchored visual; frosted glass; global hotkey.

Talks to the same `/tmp/claude-agent.sock` your Raycast extension uses. The daemon, MCPs, and memory system are unchanged — this is just a different client.

## Quick start

```bash
cd ~/Documents/my-agent/spotlight
npm install
npm run tauri dev
```

First Rust build takes a few minutes (compiles all Tauri deps). Subsequent runs are fast.

## Bind the global hotkey

Default: **⌘⇧Space** — toggles the window (show / hide). Edit `src-tauri/src/main.rs` to change (look for `Modifiers::SUPER | Modifiers::SHIFT, Code::Space`).

## Usage

| Key | Action |
|---|---|
| `⌘⇧Space` | Toggle window |
| Type + `↵` | Send query |
| `Esc` | Clear input → clear response → hide window |
| `⌘K` | Clear current response |
| `⌘⇧R` | Restart daemon |
| Type `/restart` + `↵` | Restart daemon (alternative) |
| Click outside | Auto-hide |

## Build a real .app

```bash
npm run tauri build
```

Produces `src-tauri/target/release/bundle/macos/Spotlight.app`. Drag to `/Applications`. Add to login items if you want it always available.

## Architecture

```
~/Documents/my-agent/spotlight/
├── index.html              # markup: input + response pane
├── src/
│   ├── main.ts             # send query, render markdown, handle keys
│   └── style.css           # the look
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json     # window: frameless, transparent, alwaysOnTop, vibrancy
    └── src/main.rs         # Unix socket client, launchctl restart, global hotkey
```

The Rust side opens a Unix socket to the daemon, writes `{"query": "..."}`, and forwards `{"chunk": "..."}` events back to the frontend through a Tauri Channel. The frontend appends each chunk and re-renders markdown.

## Notes

- `macOSPrivateApi` is enabled so we can use `NSVisualEffectView` for the frosted glass.
- The window auto-hides on focus loss — same UX as macOS Spotlight.
- The daemon must be running. If `/tmp/claude-agent.sock` doesn't exist, queries surface a connection error in red.
