import Foundation

/// One round-trip in the chat: the user's prompt and (eventually) the
/// assistant's streamed reply. Tool events appear inline between text
/// chunks; we render them as muted system lines.
struct Turn: Identifiable, Equatable {
    let id: UUID
    let query: String
    var images: [UploadedAttachment]
    var segments: [Segment]
    var fullText: String
    var done: Bool
    var errored: Bool

    enum Segment: Equatable {
        case text(String)
        case tool(name: String, label: String)
        case question(QuestionPrompt, answered: Bool)
    }

    static func user(query: String, images: [UploadedAttachment] = []) -> Turn {
        Turn(
            id: UUID(),
            query: query,
            images: images,
            segments: [],
            fullText: "",
            done: false,
            errored: false
        )
    }

    mutating func appendChunk(_ s: String) {
        fullText += s
        if case .text(let prev) = segments.last {
            segments[segments.count - 1] = .text(prev + s)
        } else {
            segments.append(.text(s))
        }
    }

    mutating func appendTool(name: String, label: String) {
        segments.append(.tool(name: name, label: label))
    }

    mutating func appendQuestion(_ q: QuestionPrompt) {
        segments.append(.question(q, answered: false))
    }

    mutating func markQuestionAnswered(_ requestId: String) {
        for i in segments.indices {
            if case .question(let q, _) = segments[i], q.id == requestId {
                segments[i] = .question(q, answered: true)
            }
        }
    }
}

// MARK: AskUserQuestion

/// An AskUserQuestion prompt the daemon parked the turn on. The reply rides the
/// live query connection as {answer:{request_id,answers}}; answers are keyed by
/// the exact question text -> chosen option label(s).
struct QuestionPrompt: Equatable, Identifiable {
    let id: String          // request_id
    let questions: [QuestionItem]
}

struct QuestionItem: Equatable, Decodable {
    let question: String
    let header: String?
    let multiSelect: Bool?
    let options: [QuestionOption]
}

struct QuestionOption: Equatable, Decodable {
    let label: String
    let description: String?
}

/// An image already pushed to the host's spotlight-images/ directory; we
/// reference it by absolute path so the model can read it back via its
/// filesystem tools when the prompt mentions it.
struct UploadedAttachment: Identifiable, Equatable {
    let id: UUID
    let remotePath: String
    let previewData: Data?

    init(remotePath: String, previewData: Data? = nil) {
        self.id = UUID()
        self.remotePath = remotePath
        self.previewData = previewData
    }
}
