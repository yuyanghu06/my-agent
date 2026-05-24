import Foundation
import SwiftUI

/// Persists the list of sessions (one per claude conversation UUID we've
/// touched). Lives in the app's Documents directory as a single JSON file.
@MainActor
final class SessionStore: ObservableObject {
    @Published var sessions: [ChatSession] = []

    private let fileURL: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return dir.appendingPathComponent("sessions.json")
    }()

    init() { load() }

    func load() {
        guard
            let data = try? Data(contentsOf: fileURL),
            let parsed = try? JSONDecoder().decode([ChatSession].self, from: data)
        else { return }
        sessions = parsed.sorted { $0.lastTouched > $1.lastTouched }
    }

    func save() {
        guard let data = try? JSONEncoder().encode(sessions) else { return }
        try? data.write(to: fileURL, options: [.atomic])
    }

    func upsert(_ session: ChatSession) {
        if let i = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[i] = session
        } else {
            sessions.insert(session, at: 0)
        }
        sessions.sort { $0.lastTouched > $1.lastTouched }
        save()
    }

    func remove(_ id: UUID) {
        sessions.removeAll { $0.id == id }
        save()
    }
}
