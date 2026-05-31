import SwiftUI

// MARK: - Slate Liquid Glass design tokens (mirror the Figma board)

extension Color {
    static let glassInk = Color(red: 0.102, green: 0.090, blue: 0.078)       // #1A1714
    static let glassSecondary = Color(red: 0.431, green: 0.416, blue: 0.392) // #6E6A64
    static let glassCanvas = Color(red: 0.925, green: 0.918, blue: 0.898)    // #ECEAE5
    static let glassAccent = Color(red: 0.267, green: 0.333, blue: 0.478)    // #44557A
    static let glassAccent2 = Color(red: 0.576, green: 0.643, blue: 0.761)   // #93A4C2
    static let glassGraphite = Color(red: 0.227, green: 0.212, blue: 0.192)  // #3A3631
}

/// Slate CTA gradient (#50628C → #41527A) — matches the Figma send button / buttons.
let glassButtonGradient = LinearGradient(
    colors: [Color(red: 0.314, green: 0.384, blue: 0.549),
             Color(red: 0.255, green: 0.322, blue: 0.478)],
    startPoint: .top, endPoint: .bottom)

/// The brand aperture ring mark.
struct ApertureMark: View {
    var size: CGFloat = 22
    var body: some View {
        Circle()
            .stroke(Color.glassGraphite, lineWidth: max(2, size * 0.11))
            .frame(width: size, height: size)
    }
}

extension View {
    /// White glass surface with a hairline border, matching the Figma cards.
    func glassCard(_ radius: CGFloat = 14) -> some View {
        self
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(Color.glassInk.opacity(0.08), lineWidth: 1)
            )
    }
    /// Small uppercase section label (HOST, SAVED, …).
    func sectionLabelStyle() -> some View {
        self.font(.system(size: 11, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(Color.glassSecondary)
    }
}

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

    // Right-aligned slate-tint bubble — matches the Figma user bubble.
    private var userBubble: some View {
        HStack {
            Spacer(minLength: 36)
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
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.glassInk)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.glassAccent.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    // Slate tool chip — dot + name/label on a tint pill, matches the Figma.
    private func toolRow(name: String, label: String) -> some View {
        HStack {
            HStack(spacing: 6) {
                Circle().fill(Color.glassAccent).frame(width: 6, height: 6)
                Text(label.isEmpty ? name : "\(name)  \(label)")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(Color.glassSecondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Color.glassInk.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            Spacer(minLength: 0)
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

/// Three pulsing dots shown while the assistant is generating. Matches the
/// desktop `.typing` indicator exactly: 6px slate dots, gap 4, a 1.2s ease-in-out
/// pulse staggered 0.18s per dot (rise to peak at 40% of the cycle, fall to low
/// by 80%, hold).
///
/// Driven by `TimelineView(.animation)` rather than `withAnimation` on a @State:
/// the old version animated a scalar `t` 0→1 and derived opacity from it through
/// sin(), but SwiftUI only interpolates the body's start/end values — and since
/// the function is periodic in `t`, t=0 and t=1 produced identical opacities, so
/// the dots never moved. TimelineView re-evaluates the body every frame, so the
/// curve actually renders.
struct TypingDots: View {
    private let period = 1.2
    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    let l = level(t, i)
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 6, height: 6)
                        .scaleEffect(0.85 + 0.25 * l)
                        .opacity(0.3 + 0.7 * l)
                }
            }
            .padding(.vertical, 4)
        }
    }
    private func level(_ t: Double, _ i: Int) -> Double {
        var p = ((t - Double(i) * 0.18) / period).truncatingRemainder(dividingBy: 1)
        if p < 0 { p += 1 }
        if p < 0.4 { return ease(p / 0.4) }          // rise
        if p < 0.8 { return 1 - ease((p - 0.4) / 0.4) } // fall
        return 0                                      // hold low
    }
    private func ease(_ x: Double) -> Double { x * x * (3 - 2 * x) } // smoothstep
}

/// Thin streaming progress bar. Matches the desktop `.status-line.active`: a 3px
/// `--tint` track with a 35%-wide slate-gradient that slides left→right over a
/// 1.5s ease-in-out loop. Reserves its 3px height even when idle so the composer
/// doesn't jump when streaming starts.
struct StatusSweep: View {
    let active: Bool
    var body: some View {
        Rectangle()
            .fill(active ? Color.primary.opacity(0.10) : Color.clear)
            .frame(height: 3)
            .overlay {
                if active {
                    GeometryReader { geo in
                        let w = geo.size.width
                        let sweepW = w * 0.35
                        TimelineView(.animation) { timeline in
                            let t = timeline.date.timeIntervalSinceReferenceDate
                            let p = ease((t / 1.5).truncatingRemainder(dividingBy: 1))
                            LinearGradient(
                                colors: [Color.accentColor,
                                         Color(red: 0.576, green: 0.643, blue: 0.761)],
                                startPoint: .leading, endPoint: .trailing
                            )
                            .frame(width: sweepW)
                            .offset(x: -sweepW + (w + sweepW) * p)
                        }
                    }
                }
            }
            .clipped()
            .animation(.easeInOut(duration: 0.2), value: active)
    }
    private func ease(_ x: Double) -> Double {
        x < 0.5 ? 2 * x * x : 1 - pow(-2 * x + 2, 2) / 2 // ease-in-out
    }
}
