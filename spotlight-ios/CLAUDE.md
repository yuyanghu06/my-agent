# spotlight-ios — Agent Notes

SwiftUI iOS client for the desktop spotlight agent. The phone is **client-only**: it never spawns Claude locally. Queries go over raw TCP to a Mac running spotlight in host mode (typically reachable via Tailscale). Treat host-mode features (listening, hosting a daemon) as out of scope here — they live in the desktop `spotlight/` Tauri app.

## Layout

```
Spotlight.xcodeproj/             Hand-written pbxproj (objectVersion 56).
Spotlight/
├── SpotlightApp.swift           @main App. Owns AgentClient + SessionStore as @StateObjects.
├── Info.plist                   Privacy strings (camera, photos, mic, speech, local network).
├── Assets.xcassets/             AppIcon (1024, warm-orange aperture) + AccentColor (#C85F19, matches desktop --accent).
├── Models/
│   ├── ClientSettings.swift     UserDefaults-backed host/port/token; share-URL parser.
│   ├── Turn.swift               One user/assistant pair; segments are text or tool.
│   └── ChatSession.swift        Pointer to a claude session UUID, persisted locally.
├── Services/
│   ├── AgentClient.swift        NWConnection wrapper. Line-delimited JSON, auth first.
│   ├── SessionStore.swift       Documents/sessions.json persistence.
│   └── VoiceRecognizer.swift    On-device SFSpeechRecognizer. Audio never leaves the phone.
└── Views/
    ├── ChatView.swift           NavigationStack root. Stream + sheets.
    ├── ComposerBar.swift        Textarea, attach (PhotosPicker + camera), voice, send/cancel.
    ├── TurnView.swift           Renders one Turn. TypingDots helper here too.
    ├── MarkdownText.swift       Splits fenced ``` blocks; AttributedString for inline.
    ├── ImagePicker.swift        UIImagePickerController wrapper (camera only).
    ├── SettingsView.swift       Form for host/port/token + Test connection.
    └── SessionsView.swift       List of saved ChatSession rows + new/resume actions.
```

## Conventions

- **No new files at root.** Models go in `Models/`, services in `Services/`, views in `Views/`. When adding files, also add them to `Spotlight.xcodeproj/project.pbxproj` — there are no folder references, only group entries with explicit file refs. Add a `PBXFileReference`, a `PBXBuildFile`, a child entry in the right `PBXGroup`, and a row in `70372293…/Sources` (or `46EA6DC…/Resources` for assets/plists).
- **Generate new UUIDs** with `python3 -c "import uuid; print(uuid.uuid4().hex[:24].upper())"`. Don't reuse existing ones.
- **iOS 17+ only.** Use `.onChange(of:_:)` two-param form, `PhotosPicker`, `@Observable`/`@StateObject`, `LabeledContent`, etc.
- **`@MainActor`** for `AgentClient`, `SessionStore`, `VoiceRecognizer` — UI binding state must mutate on the main actor.
- **No third-party packages.** Stick to UIKit + SwiftUI + Network + Speech + AVFoundation + PhotosUI. Adding a Swift Package means editing the pbxproj's `XCRemoteSwiftPackageReference` section, which doesn't exist yet — keep dependencies zero unless really needed.
- **No emojis in code or UI strings** unless explicitly requested.

## Wire protocol (must match desktop host)

The host bridge in `../spotlight/src-tauri/src/main.rs` is the source of truth. Keep this in sync if you change message shapes on either side.

```
client → host:  {"auth":"<token>"}\n                       (first line on every connection)
client → host:  {"query":"..."}\n                          (main request)
client → host:  {"cancel":true}\n                          (same connection, stop in-flight)
client → host:  {"interrupt":true,"query":"..."}\n         (same connection, swap query)
client → host:  {"answer":{"request_id":"...","answers":{"<question>":"<label>"}}}\n
                                                            (same connection, answers an AskUserQuestion)
client → host:  {"fresh":true}\n                           (NEW connection; daemon flag for next turn)
client → host:  {"resume":"<uuid>"}\n                      (NEW connection; daemon flag for next turn)
client → host:  {"upload":{"kind":"image","name":"x.jpg","data":"<b64>"}}\n
                                                            (intercepted at host; never reaches daemon)

host   → client: {"session_id":"..."}\n                    (once, near start)
host   → client: {"chunk":"..."}\n                         (many)
host   → client: {"tool":"Read","label":"path/to/file"}\n  (between chunks)
host   → client: {"question":{"request_id":"...","questions":[...]}}\n
                                                            (AskUserQuestion prompt; turn parks until the client answers)
host   → client: {"done":true,"response":"..."}\n          (terminates the stream)
host   → client: {"error":"...","done":true}\n             (terminal)
host   → client: {"error":"...","cancelled":true}\n        (terminal, in response to cancel)
host   → client: {"upload_ok":true,"path":"/abs/...","size":1234}\n
host   → client: {"upload_ok":false,"error":"..."}\n
```

`fresh` and `resume` are one-shot flags the daemon records globally — they have to ride a connection that closes *before* the real query opens, hence `AgentClient.oneShot(...)`.

## Common tasks

### Build for simulator
```
cd ~/Documents/my-agent/spotlight-ios
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -configuration Debug build CODE_SIGNING_ALLOWED=NO
```

### Run on a real device
Open `Spotlight.xcodeproj` in Xcode → target → Signing & Capabilities → set DEVELOPMENT_TEAM. The pbxproj ships with `DEVELOPMENT_TEAM = ""` deliberately, since the team is per-machine.

### Add a new Swift file
1. Create the file under `Spotlight/Models/`, `Services/`, or `Views/`.
2. Generate two new 24-hex UUIDs (one fileRef, one buildFile).
3. Add to `project.pbxproj`: `PBXFileReference` row, `PBXBuildFile` row, child in the matching `PBXGroup`, line in the `PBXSourcesBuildPhase` block.
4. Re-run xcodebuild — if it fails to find the file, the group child entry is wrong.

### Test against a host
The desktop spotlight's Settings → Host card produces a `spotlight://host:port?token=…` URL. Copy it to the iOS clipboard (AirDrop a text file or Universal Clipboard) and tap **Paste share URL** in iOS Settings — it fills host/port/token in one shot.

## Things that look weird but aren't

- **`oneShot()` sleeps 80ms after sending.** The daemon writes the `fresh`/`resume` flag synchronously on receipt, but closing the connection on a fast LAN can race the write — the small delay gives it a beat.
- **Resume drops local turns.** When the user picks a saved session, `turns = []`. The actual transcript lives in claude's session store on the Mac; reconstructing it on the phone would require a separate daemon endpoint. For now the phone just hands the UUID back and lets the next reply land into an empty view.
- **No KaTeX.** AttributedString markdown doesn't render math. We surface raw TeX. If math becomes important, swap `MarkdownText` for a real Swift markdown renderer — don't add KaTeX-via-WebKit, that's heavier than the whole app.
- **Local network permission prompt.** iOS prompts on first connection attempt (Tailscale IPs are in CGNAT range and treated as local). The `NSLocalNetworkUsageDescription` string in Info.plist powers that dialog.
- **`requiresOnDeviceRecognition = true`** if the device supports it. We never send audio over the network — privacy + bandwidth.

## Out of scope (don't add without asking)

- Host mode on iOS. Phone is permanently client-only by design.
- Background streaming. iOS will tear the TCP connection when the app suspends; reconnect on foreground.
- Push notifications for completed long-running queries (would be nice; needs a daemon change and an APNs path).
- Multi-host failover. One host at a time.
