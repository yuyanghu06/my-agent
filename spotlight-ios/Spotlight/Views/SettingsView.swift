import SwiftUI

/// Client-only settings — host, port, token, plus a paste-from-clipboard
/// helper that recognizes the spotlight://host:port?token=... share URLs
/// emitted by the Mac's spotlight host card.
struct SettingsView: View {
    @EnvironmentObject var agent: AgentClient
    @State private var hostDraft: String = ""
    @State private var portDraft: String = "47330"
    @State private var tokenDraft: String = ""
    @State private var lastTestResult: String?
    @State private var testing = false

    var body: some View {
        Form {
            Section("Host") {
                LabeledContent("Host") {
                    TextField("hostname or IP", text: $hostDraft)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                LabeledContent("Port") {
                    TextField("47330", text: $portDraft)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.numberPad)
                }
                LabeledContent("Token") {
                    TextField("paste host token", text: $tokenDraft)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                }
                Button {
                    pasteShareURL()
                } label: {
                    Label("Paste share URL", systemImage: "doc.on.clipboard")
                }
            }

            Section {
                Button {
                    save()
                } label: {
                    Label("Save", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    Task { await testConnection() }
                } label: {
                    if testing {
                        ProgressView()
                    } else {
                        Label("Test connection", systemImage: "antenna.radiowaves.left.and.right")
                    }
                }
                .disabled(testing)

                if let last = lastTestResult {
                    Text(last)
                        .font(.footnote)
                        .foregroundStyle(last.hasPrefix("✓") ? .green : .red)
                }
            }

            Section("About") {
                Text(
                    "Spotlight iOS is a client for the desktop spotlight agent. "
                    + "Enable Host mode on your Mac (Spotlight → Settings → Host) "
                    + "and tap Paste share URL above to load the connection details."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .onAppear { reload() }
    }

    private func reload() {
        hostDraft = agent.settings.host
        portDraft = String(agent.settings.port)
        tokenDraft = agent.settings.token
    }

    private func save() {
        let port = Int(portDraft) ?? 47330
        agent.settings = ClientSettings(
            host: hostDraft.trimmingCharacters(in: .whitespaces),
            port: port,
            token: tokenDraft.trimmingCharacters(in: .whitespaces)
        )
        lastTestResult = nil
    }

    private func pasteShareURL() {
        guard let s = UIPasteboard.general.string,
              let parsed = ClientSettings.parse(shareURL: s)
        else {
            lastTestResult = "✗ clipboard has no spotlight:// URL"
            return
        }
        hostDraft = parsed.host
        portDraft = String(parsed.port)
        tokenDraft = parsed.token
        save()
        lastTestResult = "✓ pasted \(parsed.host):\(parsed.port)"
    }

    private func testConnection() async {
        save()
        testing = true
        defer { testing = false }
        let stream = agent.send(query: "respond with the single word OK")
        var saw = ""
        for await ev in stream {
            switch ev {
            case .chunk(let s): saw += s
            case .error(let s): lastTestResult = "✗ \(s)"; return
            case .done: lastTestResult = "✓ \(saw.trimmingCharacters(in: .whitespacesAndNewlines))"; return
            default: break
            }
        }
    }
}
