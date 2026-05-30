import SwiftUI

/// Renders one user/assistant pair. The user prompt sits in a tinted
/// bubble; tools appear as muted system rows; assistant text flows in
/// markdown blocks beneath, with a typing indicator while in flight.
struct TurnView: View {
    let turn: Turn
    let streaming: Bool
    var onAnswer: (String, [String: String]) -> Void = { _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            userBubble
            ForEach(Array(turn.segments.enumerated()), id: \.offset) { idx, seg in
                switch seg {
                case .text(let s):
                    MarkdownText(raw: s)
                case .tool(let name, let label):
                    toolRow(name: name, label: label)
                case .question(let prompt, let answered):
                    QuestionCard(prompt: prompt, answered: answered, onSubmit: onAnswer)
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

/// Interactive AskUserQuestion picker. Mirrors the desktop card: one block per
/// question with selectable options, an "Other" free-text row, and a Submit that
/// posts answers (question text -> chosen label(s)) back to the host.
struct QuestionCard: View {
    let prompt: QuestionPrompt
    let answered: Bool
    let onSubmit: (String, [String: String]) -> Void

    // Per-question selection: set of chosen labels + an Other free-text value.
    @State private var picks: [Set<String>]
    @State private var others: [String]
    @State private var showOther: [Bool]
    @State private var submitted = false

    init(prompt: QuestionPrompt, answered: Bool, onSubmit: @escaping (String, [String: String]) -> Void) {
        self.prompt = prompt
        self.answered = answered
        self.onSubmit = onSubmit
        _picks = State(initialValue: prompt.questions.map { _ in Set<String>() })
        _others = State(initialValue: prompt.questions.map { _ in "" })
        _showOther = State(initialValue: prompt.questions.map { _ in false })
    }

    private var isDisabled: Bool { answered || submitted }

    private var canSubmit: Bool {
        prompt.questions.indices.allSatisfy { i in
            !picks[i].isEmpty || !others[i].trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(prompt.questions.enumerated()), id: \.offset) { qi, q in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        if let h = q.header, !h.isEmpty {
                            Text(h.uppercased())
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Color.accentColor.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        Text(q.question).font(.callout.weight(.semibold))
                    }
                    ForEach(Array(q.options.enumerated()), id: \.offset) { _, opt in
                        optionButton(qi: qi, q: q, label: opt.label, desc: opt.description)
                    }
                    Button {
                        showOther[qi].toggle()
                    } label: {
                        Text("Other…").font(.callout)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(Color.primary.opacity(0.04))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .disabled(isDisabled)
                    if showOther[qi] {
                        TextField("Type your answer…", text: $others[qi])
                            .textFieldStyle(.roundedBorder)
                            .disabled(isDisabled)
                    }
                }
            }
            HStack {
                Spacer()
                Button("Submit") { submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(isDisabled || !canSubmit)
            }
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.accentColor.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .opacity(isDisabled ? 0.6 : 1)
    }

    private func optionButton(qi: Int, q: QuestionItem, label: String, desc: String?) -> some View {
        let selected = picks[qi].contains(label)
        return Button {
            if q.multiSelect == true {
                if selected { picks[qi].remove(label) } else { picks[qi].insert(label) }
            } else {
                picks[qi] = [label]
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.callout.weight(.semibold))
                if let d = desc, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(selected ? Color.accentColor.opacity(0.25) : Color.primary.opacity(0.04))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(selected ? Color.accentColor : Color.clear, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
    }

    private func submit() {
        var answers: [String: String] = [:]
        for (i, q) in prompt.questions.enumerated() {
            var labels = Array(picks[i])
            let other = others[i].trimmingCharacters(in: .whitespaces)
            if !other.isEmpty { labels.append(other) }
            answers[q.question] = labels.joined(separator: ", ")
        }
        submitted = true
        onSubmit(prompt.id, answers)
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
