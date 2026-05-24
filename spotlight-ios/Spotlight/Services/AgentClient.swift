import Foundation
import Network

/// Wraps the raw TCP connection that the iOS app uses to talk to a
/// spotlight host on the Mac. Wire protocol is newline-delimited JSON:
///   1. First line — { "auth": "<token>" }
///   2. { "query": "..." } or control messages like { "cancel": true }
///   3. Host streams back { "session_id": ... }, { "chunk": ... },
///      { "tool": ... }, { "done": true, "response": ... }
///
/// The same connection stays open for the lifetime of a single query so
/// that cancel/interrupt control messages reach the host alongside the
/// in-flight query.
@MainActor
final class AgentClient: ObservableObject {
    enum StreamEvent {
        case sessionId(String)
        case chunk(String)
        case tool(name: String, label: String)
        case done(response: String)
        case cancelled
        case error(String)
    }

    enum AgentError: Error, LocalizedError {
        case notConfigured
        case connectFailed(String)
        case authFailed
        case wireProtocol(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Set the host, port, and token in Settings."
            case .connectFailed(let s): return "Connect failed: \(s)"
            case .authFailed: return "Authentication failed — bad token."
            case .wireProtocol(let s): return "Bad reply from host: \(s)"
            }
        }
    }

    @Published var isStreaming = false
    @Published var settings: ClientSettings = .load() {
        didSet { settings.save() }
    }

    private var connection: NWConnection?
    private var receiveBuffer = Data()
    private var continuation: AsyncStream<StreamEvent>.Continuation?

    // MARK: queries

    /// Opens a new connection, authenticates, sends the query, and yields
    /// stream events as they arrive. The stream ends after .done or .error.
    func send(query: String, resumeUuid: String? = nil, fresh: Bool = false) -> AsyncStream<StreamEvent> {
        AsyncStream { continuation in
            self.continuation = continuation
            Task { await self.run(query: query, resumeUuid: resumeUuid, fresh: fresh) }
            continuation.onTermination = { @Sendable _ in
                Task { @MainActor in self.tearDown() }
            }
        }
    }

    /// Sends a control message on the current connection. Used for cancel
    /// and interrupt — they have to ride the same socket the daemon
    /// associates with the live query.
    func sendControl(_ json: [String: Any]) async {
        guard let connection else { return }
        guard let data = encodeLine(json) else { return }
        connection.send(content: data, completion: .contentProcessed { _ in })
    }

    /// Tells the host to start a fresh claude session on the next turn.
    /// Opens and immediately closes a control-only connection so the flag
    /// is recorded on the daemon before the next real query.
    func startFresh() async {
        await oneShot(["fresh": true])
    }

    func resume(uuid: String) async {
        await oneShot(["resume": uuid])
    }

    func cancel() async {
        await sendControl(["cancel": true])
    }

    func interrupt(query: String) async {
        await sendControl(["query": query, "interrupt": true])
    }

    // MARK: uploads

    /// Ships an image to the host's spotlight-images/ folder via the host's
    /// upload-intercept protocol. Returns the absolute path the host saved
    /// it at, which can be included verbatim in a follow-up query.
    func uploadImage(name: String, data: Data) async throws -> String {
        try await upload(kind: "image", name: name, data: data)
    }

    func uploadFile(name: String, data: Data) async throws -> String {
        try await upload(kind: "file", name: name, data: data)
    }

    private func upload(kind: String, name: String, data: Data) async throws -> String {
        guard settings.isValid else { throw AgentError.notConfigured }
        let (conn, _) = try await openAuthedConnection()
        defer { conn.cancel() }
        let payload: [String: Any] = [
            "upload": [
                "kind": kind,
                "name": name,
                "data": data.base64EncodedString(),
            ]
        ]
        guard let line = encodeLine(payload) else {
            throw AgentError.wireProtocol("encode failed")
        }
        try await sendData(line, on: conn)
        let reply = try await readLine(on: conn, timeout: 30)
        guard
            let obj = try? JSONSerialization.jsonObject(with: reply) as? [String: Any]
        else { throw AgentError.wireProtocol("not JSON") }
        if let ok = obj["upload_ok"] as? Bool, ok, let path = obj["path"] as? String {
            return path
        }
        throw AgentError.wireProtocol(obj["error"] as? String ?? "upload failed")
    }

    // MARK: query driver

    private func run(query: String, resumeUuid: String?, fresh: Bool) async {
        guard settings.isValid else {
            yieldError(AgentError.notConfigured.localizedDescription)
            return
        }
        isStreaming = true
        defer { isStreaming = false }

        // For resume/fresh, send a control on a one-shot connection first so
        // the daemon records the flag, then issue the real query on a new
        // socket. The daemon stores these globally for the next runQuery.
        if let resumeUuid { await oneShot(["resume": resumeUuid]) }
        if fresh { await oneShot(["fresh": true]) }

        let conn: NWConnection
        do {
            (conn, _) = try await openAuthedConnection()
        } catch {
            yieldError((error as? LocalizedError)?.errorDescription ?? "\(error)")
            return
        }
        connection = conn

        guard let queryLine = encodeLine(["query": query]) else {
            yieldError("encode failed")
            return
        }
        do {
            try await sendData(queryLine, on: conn)
        } catch {
            yieldError("send failed: \(error)")
            return
        }

        await streamLoop(on: conn)
    }

    private func streamLoop(on conn: NWConnection) async {
        while true {
            do {
                let line = try await readLine(on: conn, timeout: 600)
                guard !line.isEmpty else { continue }
                guard
                    let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
                else { continue }

                if let err = obj["error"] as? String {
                    if (obj["cancelled"] as? Bool) == true {
                        yield(.cancelled)
                    } else {
                        yieldError(err)
                    }
                    return
                }
                if let sid = obj["session_id"] as? String {
                    yield(.sessionId(sid))
                }
                if let tool = obj["tool"] as? String {
                    let label = (obj["label"] as? String) ?? ""
                    yield(.tool(name: tool, label: label))
                }
                if let chunk = obj["chunk"] as? String, !chunk.isEmpty {
                    yield(.chunk(chunk))
                }
                if (obj["done"] as? Bool) == true {
                    let response = (obj["response"] as? String) ?? ""
                    yield(.done(response: response))
                    return
                }
            } catch {
                yieldError("stream ended: \(error)")
                return
            }
        }
    }

    private func tearDown() {
        connection?.cancel()
        connection = nil
        continuation = nil
        receiveBuffer = Data()
    }

    private func yield(_ ev: StreamEvent) {
        continuation?.yield(ev)
    }

    private func yieldError(_ s: String) {
        continuation?.yield(.error(s))
        continuation?.finish()
    }

    // MARK: low-level connection plumbing

    private func openAuthedConnection() async throws -> (NWConnection, ClientSettings) {
        let s = settings
        guard s.isValid else { throw AgentError.notConfigured }

        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(s.host),
            port: NWEndpoint.Port(integerLiteral: UInt16(s.port))
        )
        let params = NWParameters.tcp
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
            tcp.connectionTimeout = 8
        }
        let conn = NWConnection(to: endpoint, using: params)
        try await waitReady(conn)
        guard let authLine = encodeLine(["auth": s.token]) else {
            conn.cancel()
            throw AgentError.wireProtocol("encode auth failed")
        }
        try await sendData(authLine, on: conn)
        return (conn, s)
    }

    private func waitReady(_ conn: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            var resumed = false
            conn.stateUpdateHandler = { state in
                if resumed { return }
                switch state {
                case .ready:
                    resumed = true
                    cont.resume()
                case .failed(let err):
                    resumed = true
                    cont.resume(throwing: AgentError.connectFailed(err.localizedDescription))
                case .cancelled:
                    if !resumed {
                        resumed = true
                        cont.resume(throwing: AgentError.connectFailed("cancelled"))
                    }
                default: break
                }
            }
            conn.start(queue: .global(qos: .userInitiated))
        }
    }

    private func sendData(_ data: Data, on conn: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { err in
                if let err { cont.resume(throwing: err) }
                else { cont.resume() }
            })
        }
    }

    /// Reads bytes off the wire, accumulating into `receiveBuffer` until a
    /// newline is found; returns the next complete line (without the \n).
    private func readLine(on conn: NWConnection, timeout: TimeInterval) async throws -> Data {
        while true {
            if let nl = receiveBuffer.firstIndex(of: 0x0a) {
                let line = receiveBuffer[..<nl]
                receiveBuffer.removeSubrange(...nl)
                return line
            }
            let chunk = try await receiveChunk(on: conn, timeout: timeout)
            if chunk.isEmpty { throw AgentError.wireProtocol("connection closed") }
            receiveBuffer.append(chunk)
        }
    }

    private func receiveChunk(on conn: NWConnection, timeout: TimeInterval) async throws -> Data {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, err in
                if let err {
                    cont.resume(throwing: err)
                } else if let data, !data.isEmpty {
                    cont.resume(returning: data)
                } else if isComplete {
                    cont.resume(returning: Data())
                } else {
                    cont.resume(returning: Data())
                }
            }
        }
    }

    private func oneShot(_ json: [String: Any]) async {
        do {
            let (conn, _) = try await openAuthedConnection()
            defer { conn.cancel() }
            if let line = encodeLine(json) {
                try? await sendData(line, on: conn)
            }
            // Give the host a moment to register the control flag before we
            // close — the daemon writes "fresh" / "resume" state on receipt
            // synchronously, so a small wait is enough.
            try? await Task.sleep(nanoseconds: 80_000_000)
        } catch {
            // Best-effort: errors here just mean the next real query won't
            // be flagged. The caller surfaces them when it tries to run.
        }
    }

    private func encodeLine(_ obj: [String: Any]) -> Data? {
        guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed]) else {
            return nil
        }
        data.append(0x0a)
        return data
    }
}
