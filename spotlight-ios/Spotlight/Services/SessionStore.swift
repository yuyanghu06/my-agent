import Foundation
import SwiftUI

/// Host-backed session list. The canonical list lives in the host's
/// spotlight-sessions/sessions.json (shared by the desktop + every client);
/// this store reads it over the wire via AgentClient and writes back per-session
/// merges, so the phone edits the same list the Mac shows. A local copy is kept
/// in the app's Documents dir purely as an offline cache — shown until the next
/// successful refresh.
@MainActor
final class SessionStore: ObservableObject {
    @Published var sessions: [ChatSession] = []

    /// Per-session conversation history (query + assistant text pairs), keyed by
    /// session id. Populated from the host on `refresh` so opening a session can
    /// render its full transcript instead of a blank view.
    private(set) var historyById: [String: [(query: String, fullText: String)]] = [:]

    func history(for id: String) -> [(query: String, fullText: String)] {
        historyById[id] ?? []
    }

    private let fileURL: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return dir.appendingPathComponent("sessions-cache.json")
    }()

    init() { loadCache() }

    // MARK: host sync

    /// Pull the shared list from the host. On success, replaces `sessions` and
    /// refreshes the offline cache. On failure (host unreachable) the cached
    /// list is left in place.
    func refresh(via agent: AgentClient) async {
        guard let raw = await agent.fetchSessions() else { return }
        let mapped = raw.compactMap(Self.decodeHost).sorted { $0.lastTouched > $1.lastTouched }
        // Index each session's turns so resume can rebuild the full transcript.
        var hist: [String: [(query: String, fullText: String)]] = [:]
        for d in raw {
            guard let id = d["id"] as? String else { continue }
            hist[id] = Self.decodeTurns(d["turns"])
        }
        sessions = mapped
        historyById = hist
        saveCache()
    }

    /// Host turns are `{ query, fullText, ... }` (desktop) or `{ query, fullText }`
    /// (iOS) — both expose query + fullText, so the mapping is uniform.
    private static func decodeTurns(_ raw: Any?) -> [(query: String, fullText: String)] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        return arr.compactMap { t in
            let q = (t["query"] as? String) ?? ""
            let full = (t["fullText"] as? String) ?? (t["response"] as? String) ?? ""
            if q.isEmpty && full.isEmpty { return nil }
            return (q, full)
        }
    }

    /// Add or edit a session on the host. `turns` are the (query, fullText)
    /// pairs so a session created/edited on the phone is resumable on the
    /// desktop too. Optimistically updates the local list, then syncs.
    func upsert(_ session: ChatSession, turns: [[String: String]], via agent: AgentClient) async {
        if let i = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[i] = session
        } else {
            sessions.insert(session, at: 0)
        }
        sessions.sort { $0.lastTouched > $1.lastTouched }
        saveCache()
        await agent.upsertSession(Self.encodeHost(session, turns: turns))
    }

    func remove(_ id: String, via agent: AgentClient) async {
        sessions.removeAll { $0.id == id }
        saveCache()
        await agent.deleteSession(id: id)
    }

    // MARK: host <-> ChatSession mapping

    /// Host schema: { id, savedAt(ms), title, preview, turns, claudeSessionId? }.
    /// Desktop entries have no `title`, so fall back to `preview`.
    private static func decodeHost(_ d: [String: Any]) -> ChatSession? {
        guard let id = d["id"] as? String else { return nil }
        let savedAtMs = (d["savedAt"] as? Double) ?? (d["savedAt"] as? Int).map(Double.init) ?? 0
        let title = (d["title"] as? String) ?? (d["preview"] as? String) ?? "Untitled"
        return ChatSession(
            id: id,
            title: title,
            claudeSessionId: d["claudeSessionId"] as? String,
            lastTouched: Date(timeIntervalSince1970: savedAtMs / 1000),
            preview: (d["preview"] as? String) ?? ""
        )
    }

    private static func encodeHost(_ s: ChatSession, turns: [[String: String]]) -> [String: Any] {
        var d: [String: Any] = [
            "id": s.id,
            "savedAt": Int(s.lastTouched.timeIntervalSince1970 * 1000),
            "title": s.title,
            "preview": s.preview,
            "turns": turns,
        ]
        if let csid = s.claudeSessionId { d["claudeSessionId"] = csid }
        return d
    }

    // MARK: offline cache

    private func loadCache() {
        guard
            let data = try? Data(contentsOf: fileURL),
            let parsed = try? JSONDecoder().decode([ChatSession].self, from: data)
        else { return }
        sessions = parsed.sorted { $0.lastTouched > $1.lastTouched }
    }

    private func saveCache() {
        guard let data = try? JSONEncoder().encode(sessions) else { return }
        try? data.write(to: fileURL, options: [.atomic])
    }
}
