import SwiftUI

@main
struct SpotlightApp: App {
    @StateObject private var agent = AgentClient()
    @StateObject private var sessions = SessionStore()

    var body: some Scene {
        WindowGroup {
            ChatView()
                .environmentObject(agent)
                .environmentObject(sessions)
        }
    }
}
