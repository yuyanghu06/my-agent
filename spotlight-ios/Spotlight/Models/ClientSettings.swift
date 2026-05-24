import Foundation

/// Connection details for the spotlight host running on the user's Mac.
/// Mirrors the desktop spotlight's client-mode settings; the only mode
/// supported on iOS is "client" — the phone never spawns Claude locally.
struct ClientSettings: Codable, Equatable {
    var host: String
    var port: Int
    var token: String

    static let storeKey = "spotlight.clientSettings.v1"

    static var empty: ClientSettings {
        ClientSettings(host: "", port: 47330, token: "")
    }

    var isValid: Bool {
        !host.trimmingCharacters(in: .whitespaces).isEmpty
            && port > 0
            && port < 65_536
            && !token.trimmingCharacters(in: .whitespaces).isEmpty
    }

    static func load() -> ClientSettings {
        guard
            let data = UserDefaults.standard.data(forKey: storeKey),
            let s = try? JSONDecoder().decode(ClientSettings.self, from: data)
        else { return .empty }
        return s
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.storeKey)
        }
    }

    /// Parse `spotlight://host:port?token=...` URLs produced by the desktop
    /// spotlight's host-mode share button.
    static func parse(shareURL: String) -> ClientSettings? {
        guard let url = URL(string: shareURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "spotlight",
              let host = url.host,
              let port = url.port
        else { return nil }
        let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "token" })?
            .value ?? ""
        return ClientSettings(host: host, port: port, token: token)
    }
}
