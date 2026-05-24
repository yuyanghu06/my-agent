import Foundation

/// A persisted conversation pointer. The actual transcript lives in
/// claude's session store on the Mac; the iOS app only needs the UUID to
/// ask the daemon to `--resume` it on the next turn.
struct ChatSession: Identifiable, Codable, Equatable {
    let id: UUID
    var title: String
    var claudeSessionId: String?
    var lastTouched: Date
    var preview: String

    init(
        id: UUID = UUID(),
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
}
