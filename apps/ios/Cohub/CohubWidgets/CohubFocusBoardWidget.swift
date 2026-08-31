import SwiftUI
import WidgetKit

private enum CohubFocusBoardEntryState {
  case available(CohubActivitySnapshot)
  case missing
  case invalid
}

private struct CohubFocusBoardEntry: TimelineEntry {
  let date: Date
  let state: CohubFocusBoardEntryState
}

private struct CohubFocusBoardProvider: TimelineProvider {
  func placeholder(in context: Context) -> CohubFocusBoardEntry {
    #if DEBUG
      return CohubFocusBoardEntry(date: Self.fixture.generatedAt.date, state: .available(Self.fixture))
    #else
      return CohubFocusBoardEntry(date: Date(), state: .missing)
    #endif
  }

  func getSnapshot(
    in context: Context,
    completion: @escaping (CohubFocusBoardEntry) -> Void
  ) {
    if context.isPreview {
      completion(placeholder(in: context))
    } else {
      completion(loadEntry())
    }
  }

  func getTimeline(
    in context: Context,
    completion: @escaping (Timeline<CohubFocusBoardEntry>) -> Void
  ) {
    let entry = loadEntry()
    let refreshDate: Date
    switch entry.state {
    case .available(let snapshot):
      refreshDate = max(Date().addingTimeInterval(60), snapshot.staleAt)
    case .missing, .invalid:
      refreshDate = Date().addingTimeInterval(15 * 60)
    }
    completion(Timeline(entries: [entry], policy: .after(refreshDate)))
  }

  private func loadEntry() -> CohubFocusBoardEntry {
    do {
      let snapshot = try CohubActivityStore().load()
      return CohubFocusBoardEntry(
        date: snapshot?.generatedAt.date ?? Date(),
        state: snapshot.map(CohubFocusBoardEntryState.available) ?? .missing
      )
    } catch {
      return CohubFocusBoardEntry(date: Date(), state: .invalid)
    }
  }

  #if DEBUG
    private static let fixture = CohubActivitySnapshot(
      schemaVersion: 1,
      revision: 1,
      generatedAt: CohubTimestamp(Date(timeIntervalSince1970: 1_788_169_200)),
      freshness: .live,
      primarySpaceId: "space-preview",
      primarySessionId: "session-preview",
      otherActiveCount: 2,
      boardSpaceIds: ["space-preview"],
      spaces: [
        CohubSpaceActivity(
          spaceId: "space-preview",
          spaceName: "Release workspace",
          origin: .local,
          isPrimary: true,
          activeAgentCount: 1,
          attentionCount: 0,
          activity: CohubSessionActivity(
            sessionId: "session-preview",
            sessionTitle: "Ship Focus Board",
            turnId: "turn-preview",
            status: .running,
            phase: .working,
            harness: "codex",
            model: "gpt-5.6-sol",
            summary: "Building the iPhone experience",
            startedAt: CohubTimestamp(Date(timeIntervalSince1970: 1_788_169_080)),
            updatedAt: CohubTimestamp(Date(timeIntervalSince1970: 1_788_169_200)),
            errorMessage: nil
          )
        )
      ]
    )
  #endif
}

struct CohubFocusBoardWidget: Widget {
  static let kind = "CohubFocusBoard"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: CohubFocusBoardProvider()) { entry in
      CohubFocusBoardView(entry: entry)
        .containerBackground(for: .widget) {
          Color(uiColor: .secondarySystemBackground)
        }
    }
    .configurationDisplayName("Focus Board")
    .description("Pinned Spaces and their current attention state.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

private struct CohubFocusBoardView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CohubFocusBoardEntry

  var body: some View {
    switch entry.state {
    case .available(let snapshot):
      if family == .systemSmall {
        small(snapshot)
      } else {
        medium(snapshot)
      }
    case .missing:
      unavailable(title: "No Focus Board", symbol: "rectangle.stack")
    case .invalid:
      unavailable(title: "Snapshot error", symbol: "exclamationmark.triangle")
    }
  }

  private func small(_ snapshot: CohubActivitySnapshot) -> some View {
    Group {
      if
        let space = snapshot.boardSpaces.first,
        let destination = CohubDeepLink.space(space.spaceId, origin: space.origin)
      {
        Link(destination: destination) {
          VStack(alignment: .leading, spacing: 10) {
            boardHeader(snapshot)
            Spacer(minLength: 0)
            Text(space.spaceName)
              .font(.headline)
              .lineLimit(2)
            spaceStatus(space)
          }
        }
      } else {
        unavailable(title: "No primary Space", symbol: "scope")
      }
    }
  }

  private func medium(_ snapshot: CohubActivitySnapshot) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      boardHeader(snapshot)
      if snapshot.boardSpaces.isEmpty {
        Spacer()
        Text("No pinned Spaces")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        Spacer()
      } else {
        ForEach(Array(snapshot.boardSpaces.enumerated()), id: \.element.spaceId) { index, space in
          if let destination = CohubDeepLink.space(space.spaceId, origin: space.origin) {
            Link(destination: destination) {
              HStack(spacing: 8) {
                Circle()
                  .fill(statusColor(space))
                  .frame(width: 7, height: 7)
                Text(space.spaceName)
                  .font(.subheadline.weight(space.isPrimary ? .semibold : .regular))
                  .lineLimit(1)
                Spacer(minLength: 6)
                Text(rowStatus(space))
                  .font(.caption)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
              }
              .contentShape(Rectangle())
            }
          }
          if index < snapshot.boardSpaces.count - 1 {
            Divider()
          }
        }
      }
    }
  }

  private func boardHeader(_ snapshot: CohubActivitySnapshot) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "circle.hexagongrid.fill")
        .foregroundStyle(Color(red: 1, green: 0.24, blue: 0))
      Text("Focus Board")
        .font(.caption.weight(.semibold))
      Spacer(minLength: 4)
      Text(freshnessLabel(snapshot.effectiveFreshness()))
        .font(.caption2.weight(.medium))
        .foregroundStyle(freshnessColor(snapshot.effectiveFreshness()))
    }
  }

  private func spaceStatus(_ space: CohubSpaceActivity) -> some View {
    HStack(spacing: 6) {
      Circle()
        .fill(statusColor(space))
        .frame(width: 7, height: 7)
      Text(rowStatus(space))
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }

  private func rowStatus(_ space: CohubSpaceActivity) -> String {
    if space.attentionCount > 0 { return "\(space.attentionCount) need attention" }
    if let activity = space.activity {
      return statusLabel(activity.status)
    }
    if space.activeAgentCount > 0 { return "\(space.activeAgentCount) active" }
    return "Idle"
  }

  private func statusColor(_ space: CohubSpaceActivity) -> Color {
    if space.attentionCount > 0 { return .orange }
    switch space.activity?.status {
    case .failed, .interrupted: return .red
    case .running, .queued, .abortRequested: return .green
    default: return .secondary
    }
  }

  private func unavailable(title: String, symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Image(systemName: symbol)
        .foregroundStyle(.secondary)
      Text(title)
        .font(.headline)
      Text("Open Cohub to refresh")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}

func statusLabel(_ status: CohubTurnStatus) -> String {
  switch status {
  case .queued: return "Queued"
  case .running: return "Running"
  case .abortRequested: return "Stopping"
  case .completed: return "Completed"
  case .failed: return "Failed"
  case .interrupted: return "Interrupted"
  case .merged: return "Merged"
  case .cancelled: return "Cancelled"
  }
}

private func freshnessLabel(_ freshness: CohubFreshness) -> String {
  switch freshness {
  case .live: return "Live"
  case .recovering: return "Recovering"
  case .stale: return "Stale"
  case .offline: return "Offline"
  }
}

private func freshnessColor(_ freshness: CohubFreshness) -> Color {
  switch freshness {
  case .live: return .green
  case .recovering: return .orange
  case .stale: return .secondary
  case .offline: return .red
  }
}
