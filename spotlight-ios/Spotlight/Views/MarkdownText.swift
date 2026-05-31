import SwiftUI

/// Lightweight markdown renderer. Uses AttributedString's built-in markdown
/// parser for inline formatting, and splits fenced code blocks out into
/// their own monospaced views with proper line wrapping. KaTeX is *not*
/// rendered here — math comes through as raw TeX, which is acceptable for
/// a phone client.
struct MarkdownText: View {
    let raw: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .text(let s):
                    renderInline(s)
                case .code(let lang, let body):
                    codeBlock(language: lang, body: body)
                }
            }
        }
    }

    @ViewBuilder
    private func renderInline(_ s: String) -> some View {
        if let attr = try? AttributedString(
            markdown: s,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) {
            Text(attr).textSelection(.enabled)
        } else {
            Text(s).textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func codeBlock(language: String?, body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(body)
                    .font(.system(.footnote, design: .monospaced))
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color.secondary.opacity(0.12))
            .cornerRadius(8)
        }
        .textSelection(.enabled)
    }

    private enum Block { case text(String); case code(String?, String) }

    /// Turn the internal "[user injected mid-stream]: X" marker (embedded in a
    /// resumed turn's fullText) into a markdown blockquote so it reads as a
    /// quoted user aside instead of a raw internal tag.
    private static func cleanInjectionMarkers(_ s: String) -> String {
        guard s.contains("[user injected mid-stream]:") else { return s }
        return s.replacingOccurrences(
            of: #"\n*\[user injected mid-stream\]:\s*"#,
            with: "\n\n> ",
            options: .regularExpression
        )
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var lines = Self.cleanInjectionMarkers(raw).components(separatedBy: "\n").makeIterator()
        var textBuf = ""
        var current = lines.next()
        while let line = current {
            if line.hasPrefix("```") {
                if !textBuf.isEmpty {
                    out.append(.text(textBuf))
                    textBuf = ""
                }
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body = ""
                current = lines.next()
                while let inner = current, !inner.hasPrefix("```") {
                    if !body.isEmpty { body += "\n" }
                    body += inner
                    current = lines.next()
                }
                out.append(.code(lang.isEmpty ? nil : lang, body))
                current = lines.next()
                continue
            }
            if !textBuf.isEmpty { textBuf += "\n" }
            textBuf += line
            current = lines.next()
        }
        if !textBuf.isEmpty { out.append(.text(textBuf)) }
        return out
    }
}
