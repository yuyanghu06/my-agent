import SwiftUI

struct ChatView: View {
    @EnvironmentObject var agent: AgentClient
    @EnvironmentObject var sessions: SessionStore

    @State private var turns: [Turn] = []
    @State private var draft: String = ""
    @State private var pendingImages: [PendingImage] = []
    @State private var streamingTask: Task<Void, Never>?
    @State private var activeSession: ChatSession = ChatSession()
    @State private var capturedSessionId: String?
    @State private var showSettings = false
    @State private var showSessions = false

    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                Color.glassCanvas.ignoresSafeArea()
                VStack(spacing: 0) {
                    topBar
                    conversation
                    StatusSweep(active: agent.isStreaming)
                    ComposerBar(
                        text: $draft,
                        pendingImages: $pendingImages,
                        isStreaming: agent.isStreaming,
                        canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || !pendingImages.isEmpty,
                        onSend: send,
                        onCancel: cancel
                    )
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showSettings) {
                NavigationStack { SettingsView() }
            }
            .sheet(isPresented: $showSessions) {
                NavigationStack {
                    SessionsView(
                        onPick: { resume($0) },
                        onNew: { newSession() }
                    )
                }
            }
        }
    }

    // Custom top bar — aperture mark left, centered title, ⋯ menu right.
    private var topBar: some View {
        ZStack {
            Text("Spotlight")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.glassInk)
            HStack {
                ApertureMark(size: 22)
                Spacer()
                Menu {
                    Button { newSession() } label: { Label("New session", systemImage: "square.and.pencil") }
                    Button { showSessions = true } label: { Label("Sessions", systemImage: "list.bullet.rectangle") }
                    Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.glassSecondary)
                        .frame(width: 28, height: 28)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.glassInk.opacity(0.08)).frame(height: 1)
        }
    }

    // MARK: stream view

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if turns.isEmpty {
                        emptyState
                            .padding(.top, 60)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(turns) { t in
                        TurnView(
                            turn: t,
                            streaming: agent.isStreaming && t.id == turns.last?.id,
                            onAnswer: handleAnswer
                        )
                        .id(t.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: turns.last?.fullText) { _, _ in
                if let last = turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            .onChange(of: turns.count) { _, _ in
                if let last = turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            ApertureMark(size: 40)
            Text("Ask anything, paste a photo, or hold the mic.")
                .font(.system(size: 15))
                .foregroundStyle(Color.glassSecondary)
                .multilineTextAlignment(.center)
            if !agent.settings.isValid {
                Text("Open the ⋯ menu → Settings and paste your Mac's share URL to connect.")
                    .font(.footnote)
                    .foregroundStyle(Color.glassAccent)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
        }
    }

    // MARK: send

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let imagesToShip = pendingImages
        guard !text.isEmpty || !imagesToShip.isEmpty else { return }
        draft = ""
        pendingImages = []

        streamingTask?.cancel()
        streamingTask = Task { await runSend(text: text, images: imagesToShip) }
    }

    private func runSend(text: String, images: [PendingImage]) async {
        // 1) Upload any images to the host so the daemon can read them.
        var uploaded: [UploadedAttachment] = []
        var payload = text
        for img in images {
            do {
                let path = try await agent.uploadImage(name: img.name, data: img.data)
                uploaded.append(UploadedAttachment(remotePath: path, previewData: img.data))
                let mention = "[image attached at \(path)]"
                payload = payload.isEmpty ? mention : "\(payload)\n\n\(mention)"
            } catch {
                payload += "\n\n[upload failed: \(error.localizedDescription)]"
            }
        }
        if payload.isEmpty { payload = "(image only)" }

        var turn = Turn.user(query: text, images: uploaded)
        turns.append(turn)
        let turnId = turn.id

        // 2) Stream the response. Resume the active session if we already
        //    have a claude UUID for it (set after the first turn).
        let resume = activeSession.claudeSessionId
        let stream = agent.send(query: payload, resumeUuid: resume)
        for await ev in stream {
            guard !Task.isCancelled else { break }
            await MainActor.run {
                guard let i = turns.firstIndex(where: { $0.id == turnId }) else { return }
                switch ev {
                case .sessionId(let sid):
                    if capturedSessionId == nil {
                        capturedSessionId = sid
                        activeSession.claudeSessionId = sid
                        persistSession(turn: turns[i])
                    }
                case .chunk(let s):
                    turns[i].appendChunk(s)
                case .tool(let n, let l):
                    turns[i].appendTool(name: n, label: l)
                case .question(let prompt):
                    turns[i].appendQuestion(prompt)
                case .done(let response):
                    if turns[i].fullText.isEmpty && !response.isEmpty {
                        turns[i].fullText = response
                        turns[i].segments = [.text(response)]
                    }
                    turns[i].done = true
                    persistSession(turn: turns[i])
                case .cancelled:
                    turns[i].appendChunk("\n\n_(cancelled)_")
                    turns[i].done = true
                case .error(let msg):
                    turns[i].appendChunk("\n\n**Error:** \(msg)")
                    turns[i].done = true
                    turns[i].errored = true
                }
            }
        }
    }

    private func cancel() {
        Task { await agent.cancel() }
    }

    /// Submit an AskUserQuestion answer: mark the card answered locally and post
    /// it back on the live connection so the parked turn resumes streaming.
    private func handleAnswer(_ requestId: String, _ answers: [String: String]) {
        for idx in turns.indices { turns[idx].markQuestionAnswered(requestId) }
        Task { await agent.sendAnswer(requestId: requestId, answers: answers) }
    }

    // MARK: sessions

    private func newSession() {
        Task { await agent.startFresh() }
        turns = []
        capturedSessionId = nil
        activeSession = ChatSession()
    }

    private func resume(_ s: ChatSession) {
        // Hand the daemon the UUID; clear local turns since the transcript
        // lives in claude's session store, not on the phone.
        activeSession = s
        capturedSessionId = s.claudeSessionId
        turns = []
        if let uuid = s.claudeSessionId {
            Task { await agent.resume(uuid: uuid) }
        }
    }

    private func persistSession(turn: Turn) {
        // Use the first user prompt as the session title; preview tracks
        // the latest assistant text so the sessions list stays useful.
        if activeSession.title == "New session" {
            let first = turns.first?.query ?? ""
            activeSession.title = String(first.prefix(60))
        }
        activeSession.preview = String(turn.fullText.prefix(120))
        activeSession.lastTouched = Date()
        sessions.upsert(activeSession)
    }
}
