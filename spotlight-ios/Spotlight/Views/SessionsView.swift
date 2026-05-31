import SwiftUI

/// Saved sessions — styled to match the Figma board: white glass row cards on
/// the canvas, a "+ New" action, swipe-to-delete preserved via List.
struct SessionsView: View {
    @EnvironmentObject var store: SessionStore
    var onPick: (ChatSession) -> Void
    var onNew: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if store.sessions.isEmpty {
                VStack(spacing: 12) {
                    ApertureMark(size: 36)
                    Text("No saved sessions yet.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.glassSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.glassCanvas)
            } else {
                List {
                    Text("SAVED")
                        .sectionLabelStyle()
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 2, trailing: 20))
                    ForEach(store.sessions) { s in
                        Button { onPick(s); dismiss() } label: { row(s) }
                            .buttonStyle(.plain)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    }
                    .onDelete { idxs in
                        for i in idxs { store.remove(store.sessions[i].id) }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(Color.glassCanvas)
            }
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { onNew(); dismiss() } label: {
                    Label("New", systemImage: "square.and.pencil")
                        .foregroundStyle(Color.glassAccent)
                }
            }
        }
    }

    private func row(_ s: ChatSession) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(s.title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.glassInk)
                .lineLimit(1)
            if !s.preview.isEmpty {
                Text(s.preview)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color.glassSecondary)
                    .lineLimit(1)
            }
            Text(s.lastTouched, style: .relative)
                .font(.system(size: 12))
                .foregroundStyle(Color.glassSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard()
    }
}
