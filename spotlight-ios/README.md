# Spotlight iOS

SwiftUI client for the desktop spotlight agent. Targets iOS 17+.

The phone is **client-only** — it never spawns Claude locally. Queries go
over TCP to a Mac running spotlight in host mode (typically reachable via
Tailscale). Wire protocol is identical to what the desktop spotlight speaks
to its local daemon: newline-delimited JSON, auth as the first line.

## Setup

1. On your Mac, open Spotlight → Settings → **Host**, toggle on, copy the
   share URL (`spotlight://host:port?token=...`).
2. Open `Spotlight.xcodeproj` in Xcode 15+.
3. Set a development team in the target's Signing & Capabilities tab.
4. Build & run on a physical device or simulator.
5. On first launch, tap the gear icon → **Paste share URL** to import the
   host/port/token in one shot, or fill them in manually.
6. Tap **Test connection** to verify.

## Features

| Feature | Notes |
|---|---|
| Stream Claude responses | Markdown rendering (code blocks, inline formatting) |
| Photo library + camera attach | Uploaded to the Mac's `spotlight-images/` and referenced by path |
| Voice → text | On-device transcription via `SFSpeechRecognizer`; audio stays on the phone |
| Sessions | UUID-keyed, persisted locally; resume any saved session |
| Cancel / interrupt | Stops the in-flight `claude` child on the host |

## Architecture

```
SpotlightApp           — @main, owns AgentClient + SessionStore
└─ ChatView            — message list + composer
   ├─ ComposerBar      — textarea, attach menu, voice button
   ├─ TurnView         — one user/assistant pair
   ├─ MarkdownText     — fenced code blocks + inline markdown
   └─ Sheets: SettingsView, SessionsView

Services/
├─ AgentClient         — NWConnection wrapper; line-delimited JSON
├─ SessionStore        — persists sessions to Documents/sessions.json
└─ VoiceRecognizer     — SFSpeechRecognizer wrapper
```

## Wire protocol

The same as the desktop spotlight's host-mode bridge:

```
client → host:  {"auth":"<token>"}\n
client → host:  {"query":"...","..."}\n
host   → client: {"session_id":"..."}\n
host   → client: {"chunk":"..."}\n  (many)
host   → client: {"tool":"Read","label":"path/to/file"}\n
host   → client: {"done":true,"response":"..."}\n
```

Control messages on the same connection: `{"cancel":true}`, `{"interrupt":true,"query":"..."}`.
One-shot prep messages on a fresh connection: `{"fresh":true}`, `{"resume":"<uuid>"}`.

iOS-only extension intercepted at the host bridge:
```
client → host:  {"upload":{"kind":"image","name":"x.jpg","data":"<base64>"}}\n
host   → client: {"upload_ok":true,"path":"/abs/path/saved.jpg","size":1234}\n
```

## Privacy

- Voice transcription is on-device; audio is never sent over the network.
- Image uploads stay within your Tailnet; Tailscale provides the only
  network-level boundary, but the per-host token gates the connection
  regardless of who can reach the port.
