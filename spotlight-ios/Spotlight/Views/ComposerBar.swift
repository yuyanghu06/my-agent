import SwiftUI
import PhotosUI

/// Bottom composer: textarea, attach photo (library or camera), voice
/// (hold-to-talk), send. Shows pending attachments as chips above the
/// textarea before they get sent.
struct ComposerBar: View {
    @Binding var text: String
    @Binding var pendingImages: [PendingImage]
    let isStreaming: Bool
    let canSend: Bool
    let onSend: () -> Void
    let onCancel: () -> Void

    @State private var photoItem: PhotosPickerItem?
    @State private var showCamera = false
    @StateObject private var voice = VoiceRecognizer()
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 6) {
            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(pendingImages) { p in
                            attachmentChip(p)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
            if let err = voice.lastError {
                Text(err).font(.caption2).foregroundStyle(.red)
            }
            HStack(alignment: .bottom, spacing: 8) {
                attachMenu
                TextField("Ask Claude…", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .padding(8)
                    .background(Color(uiColor: .secondarySystemBackground))
                    .cornerRadius(12)
                    .focused($focused)
                voiceButton
                sendButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.ultraThinMaterial)
        .onChange(of: photoItem) { _, newItem in
            guard let newItem else { return }
            Task { await loadPickedPhoto(newItem); photoItem = nil }
        }
        .sheet(isPresented: $showCamera) {
            CameraPicker { img in
                if let data = img.jpegData(compressionQuality: 0.85) {
                    pendingImages.append(PendingImage(data: data, name: "camera.jpg"))
                }
            }
            .ignoresSafeArea()
        }
    }

    private var attachMenu: some View {
        Menu {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
            Button {
                showCamera = true
            } label: {
                Label("Take Photo", systemImage: "camera")
            }
        } label: {
            Image(systemName: "plus.circle.fill")
                .imageScale(.large)
                .foregroundStyle(.secondary)
        }
    }

    private var voiceButton: some View {
        Button {
            // toggle
            if voice.isRecording {
                voice.stop()
                let captured = voice.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if !captured.isEmpty {
                    text = (text.isEmpty ? captured : "\(text) \(captured)")
                }
            } else {
                Task { await voice.start() }
            }
        } label: {
            Image(systemName: voice.isRecording ? "waveform.circle.fill" : "mic.circle")
                .imageScale(.large)
                .foregroundStyle(voice.isRecording ? .red : .secondary)
                .symbolEffect(.pulse, options: .repeating, isActive: voice.isRecording)
        }
    }

    @ViewBuilder
    private var sendButton: some View {
        if isStreaming {
            Button(role: .destructive, action: onCancel) {
                Image(systemName: "stop.circle.fill")
                    .imageScale(.large)
                    .foregroundStyle(.red)
            }
        } else {
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .imageScale(.large)
                    .foregroundStyle(canSend ? Color.accentColor : Color.secondary)
            }
            .disabled(!canSend)
        }
    }

    private func attachmentChip(_ p: PendingImage) -> some View {
        ZStack(alignment: .topTrailing) {
            if let ui = UIImage(data: p.data) {
                Image(uiImage: ui)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 64, height: 64)
                    .clipped()
                    .cornerRadius(8)
            }
            Button {
                pendingImages.removeAll { $0.id == p.id }
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.white, .black.opacity(0.7))
                    .imageScale(.small)
                    .padding(2)
            }
        }
    }

    private func loadPickedPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        await MainActor.run {
            pendingImages.append(PendingImage(data: data, name: "library.jpg"))
        }
    }
}

struct PendingImage: Identifiable, Equatable {
    let id = UUID()
    let data: Data
    let name: String
}
