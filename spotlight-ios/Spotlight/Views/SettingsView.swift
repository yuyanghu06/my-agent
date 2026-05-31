import SwiftUI

/// Client-only settings — host, port, token, plus a paste-from-clipboard
/// helper that recognizes the spotlight://host:port?token=... share URLs
/// emitted by the Mac's spotlight host card. Styled to match the Figma
/// slate-glass board (the phone is client-only, so there is no Host-mode
/// toggle — that lives on the desktop app).
struct SettingsView: View {
    @EnvironmentObject var agent: AgentClient
    @Environment(\.dismiss) private var dismiss
    @State private var hostDraft: String = ""
    @State private var portDraft: String = "47330"
    @State private var tokenDraft: String = ""
    @State private var lastTestResult: String?
    @State private var testing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // CONNECTION card
                Text("CONNECTION").sectionLabelStyle().padding(.leading, 4)
                VStack(spacing: 14) {
                    field("HOST", text: $hostDraft, placeholder: "hostname or IP", mono: false, number: false)
                    field("PORT", text: $portDraft, placeholder: "47330", mono: false, number: true)
                    field("TOKEN", text: $tokenDraft, placeholder: "paste host token", mono: true, number: false)
                }
                .padding(16)
                .glassCard()

                // Paste share URL — tinted secondary action
                Button { pasteShareURL() } label: {
                    Label("Paste share URL", systemImage: "doc.on.clipboard")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Color.glassAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.glassAccent.opacity(0.10))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)

                // Test connection — slate gradient CTA
                Button { Task { await testConnection() } } label: {
                    Group {
                        if testing {
                            ProgressView().tint(.white)
                        } else {
                            Text("Test connection").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(glassButtonGradient)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(testing)

                if let last = lastTestResult {
                    Text(last)
                        .font(.footnote)
                        .foregroundStyle(last.hasPrefix("✓") ? Color(red: 0.247, green: 0.490, blue: 0.306) : .red)
                        .padding(.leading, 4)
                }

                Text("Spotlight iOS is a client for the desktop spotlight agent. Enable Host mode on your Mac (Spotlight → Settings → Host) and tap Paste share URL above to load the connection details.")
                    .font(.footnote)
                    .foregroundStyle(Color.glassSecondary)
                    .padding(.top, 4)
                    .padding(.horizontal, 4)
            }
            .padding(16)
        }
        .background(Color.glassCanvas)
        .scrollContentBackground(.hidden)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { save(); dismiss() }
                    .foregroundStyle(Color.glassAccent)
            }
        }
        .onAppear { reload() }
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String, mono: Bool, number: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).sectionLabelStyle()
            TextField(placeholder, text: text)
                .font(.system(size: 15, design: mono ? .monospaced : .default))
                .foregroundStyle(Color.glassInk)
                .tint(Color.glassAccent)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(number ? .numberPad : .default)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .background(Color.glassInk.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color.glassInk.opacity(0.08), lineWidth: 1)
                )
        }
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
