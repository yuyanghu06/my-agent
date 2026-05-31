import SwiftUI
import PhotosUI

/// Bottom composer: a white floating glass pill (matches the Figma) with the
/// aperture mark, the text field, attach (photo library or camera), voice
/// (hold-to-talk), and a slate-gradient send button. Pending attachments show
/// as thumbnails above the pill before they get sent.
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
        VStack(spacing: 8) {
            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(pendingImages) { p in
                            attachmentChip(p)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            if let err = voice.lastError {
                Text(err).font(.caption2).foregroundStyle(.red)
            }
            HStack(alignment: .center, spacing: 10) {
                ApertureMark(size: 20)
                TextField("Ask anything…", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.glassInk)
                    .tint(Color.glassAccent)
                    .focused($focused)
                attachMenu
                voiceButton
                sendButton
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .padding(.vertical, 8)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.glassInk.opacity(0.10), lineWidth: 1)
            )
            .shadow(color: Color.glassInk.opacity(0.12), radius: 14, y: 4)
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 8)
        }
        .background(Color.glassCanvas)
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
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.glassSecondary)
                .frame(width: 28, height: 28)
        }
    }

    private var voiceButton: some View {
        Button {
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
            Image(systemName: voice.isRecording ? "waveform" : "mic")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(voice.isRecording ? Color.red : Color.glassSecondary)
                .frame(width: 28, height: 28)
                .symbolEffect(.pulse, options: .repeating, isActive: voice.isRecording)
        }
    }

    @ViewBuilder
    private var sendButton: some View {
        if isStreaming {
            Button(action: onCancel) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(Color.glassSecondary)
                    .clipShape(Circle())
            }
        } else {
            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(canSend ? AnyShapeStyle(glassButtonGradient)
                                        : AnyShapeStyle(Color.glassInk.opacity(0.18)))
                    .clipShape(Circle())
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
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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
