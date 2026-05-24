import SwiftUI

/// Renders one user/assistant pair. The user prompt sits in a tinted
/// bubble; tools appear as muted system rows; assistant text flows in
/// markdown blocks beneath, with a typing indicator while in flight.
struct TurnView: View {
    let turn: Turn
    let streaming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            userBubble
            ForEach(Array(turn.segments.enumerated()), id: \.offset) { idx, seg in
                switch seg {
                case .text(let s):
                    MarkdownText(raw: s)
                case .tool(let name, let label):
                    toolRow(name: name, label: label)
                }
            }
            if streaming && !turn.done && !turn.errored {
                TypingDots()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var userBubble: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !turn.images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(turn.images) { img in
                            if let data = img.previewData, let ui = UIImage(data: data) {
                                Image(uiImage: ui)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 84, height: 84)
                                    .clipped()
                                    .cornerRadius(8)
                            }
                        }
                    }
                }
            }
            Text(turn.query.isEmpty ? "(no text)" : turn.query)
                .font(.callout.weight(.medium))
                .textSelection(.enabled)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.10))
        .cornerRadius(10)
    }

    private func toolRow(name: String, label: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.right")
                .imageScale(.small)
                .foregroundStyle(.tertiary)
            Text(name).font(.caption.monospaced()).foregroundStyle(.secondary)
            if !label.isEmpty {
                Text(label).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer()
        }
    }
}

struct TypingDots: View {
    @State private var t: Double = 0
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { i in
                Circle()
                    .frame(width: 5, height: 5)
                    .opacity(opacity(for: i))
            }
        }
        .foregroundStyle(.secondary)
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                t = 1
            }
        }
    }
    private func opacity(for i: Int) -> Double {
        let phase = (t + Double(i) * 0.33).truncatingRemainder(dividingBy: 1)
        return 0.3 + 0.7 * sin(phase * .pi)
    }
}
