import SwiftUI

struct SessionsView: View {
    @EnvironmentObject var store: SessionStore
    var onPick: (ChatSession) -> Void
    var onNew: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Button {
                onNew()
                dismiss()
            } label: {
                Label("New session", systemImage: "plus.bubble")
            }
            if store.sessions.isEmpty {
                Text("No saved sessions yet.")
                    .foregroundStyle(.secondary)
                    .font(.footnote)
            }
            ForEach(store.sessions) { s in
                Button {
                    onPick(s)
                    dismiss()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.title).font(.body)
                        if !s.preview.isEmpty {
                            Text(s.preview)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Text(s.lastTouched, style: .relative)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .onDelete { idxs in
                for i in idxs { store.remove(store.sessions[i].id) }
            }
        }
        .navigationTitle("Sessions")
    }
}
