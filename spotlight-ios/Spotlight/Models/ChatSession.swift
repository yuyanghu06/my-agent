import Foundation

/// A persisted conversation pointer. The actual transcript lives in
/// claude's session store on the Mac; the iOS app only needs the UUID to
/// ask the daemon to `--resume` it on the next turn.
///
/// `id` is a String (not a UUID) so it lines up with the host's
/// spotlight-sessions/sessions.json entry ids — the iOS app reads/writes
/// that shared list over the wire, keyed by this id.
struct ChatSession: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var claudeSessionId: String?
    var lastTouched: Date
    var preview: String

    init(
        id: String = ChatSession.newId(),
        title: String = "New session",
        claudeSessionId: String? = nil,
        lastTouched: Date = Date(),
        preview: String = ""
    ) {
        self.id = id
        self.title = title
        self.claudeSessionId = claudeSessionId
        self.lastTouched = lastTouched
        self.preview = preview
    }

    /// Matches the host's localId style closely enough to be unique per device.
    static func newId() -> String {
        "ios-\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 0..<100000))"
    }
}
