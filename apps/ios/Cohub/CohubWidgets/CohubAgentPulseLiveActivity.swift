import ActivityKit
import SwiftUI
import WidgetKit

struct CohubAgentPulseLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: CohubAgentPulseAttributes.self) { context in
      CohubAgentPulseLockScreenView(context: context)
        .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
        .activitySystemActionForegroundColor(.primary)
        .widgetURL(context.state.sessionURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          pulseMark(context.state, isStale: context.isStale)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(presentation(for: context.state).sessionTitle)
            .font(.headline)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.state.otherActiveCount > 0 {
            Text("+\(context.state.otherActiveCount)")
              .font(.caption.weight(.semibold))
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          CohubAgentPulseExpandedActions(state: context.state, isStale: context.isStale)
        }
      } compactLeading: {
        pulseMark(context.state, isStale: context.isStale)
      } compactTrailing: {
        Image(systemName: statusSymbol(context.state, isStale: context.isStale))
          .foregroundStyle(statusColor(context.state, isStale: context.isStale))
      } minimal: {
        Image(systemName: statusSymbol(context.state, isStale: context.isStale))
          .foregroundStyle(statusColor(context.state, isStale: context.isStale))
      }
      .widgetURL(context.state.sessionURL)
      .keylineTint(Color(red: 1, green: 0.24, blue: 0))
    }
  }

  private func pulseMark(
    _ state: CohubAgentPulseAttributes.ContentState,
    isStale: Bool
  ) -> some View {
    Image(systemName: isStale ? "clock.badge.exclamationmark" : "waveform.path.ecg")
      .foregroundStyle(isStale ? .secondary : Color(red: 1, green: 0.24, blue: 0))
  }
}

private struct CohubAgentPulseLockScreenView: View {
  let context: ActivityViewContext<CohubAgentPulseAttributes>

  var body: some View {
    let detail = presentation(for: context.state)
    HStack(spacing: 12) {
      Image(systemName: statusSymbol(context.state, isStale: context.isStale))
        .font(.title3.weight(.semibold))
        .foregroundStyle(statusColor(context.state, isStale: context.isStale))
        .frame(width: 28)

      VStack(alignment: .leading, spacing: 3) {
        Text(detail.spaceName)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Text(detail.sessionTitle)
          .font(.headline)
          .lineLimit(1)
        Text(statusText(context.state, isStale: context.isStale))
          .font(.caption)
          .foregroundStyle(statusColor(context.state, isStale: context.isStale))
      }

      Spacer(minLength: 4)

      if context.state.otherActiveCount > 0 {
        VStack(spacing: 1) {
          Text("+\(context.state.otherActiveCount)")
            .font(.headline.monospacedDigit())
          Text("other")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }
    }
    .padding(.horizontal, 4)
  }
}

private struct CohubAgentPulseExpandedActions: View {
  let state: CohubAgentPulseAttributes.ContentState
  let isStale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(statusText(state, isStale: isStale))
          .font(.caption)
          .foregroundStyle(statusColor(state, isStale: isStale))
        Spacer()
        if state.otherActiveCount > 0 {
          Text("\(state.otherActiveCount) other active")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      if let destination = state.sessionURL {
        Link(destination: destination) {
          Label("Open Session", systemImage: "arrow.up.right.square")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Color(red: 1, green: 0.24, blue: 0))
      }
    }
  }
}

private struct CohubPulsePresentation {
  let spaceName: String
  let sessionTitle: String
}

private func presentation(
  for state: CohubAgentPulseAttributes.ContentState
) -> CohubPulsePresentation {
  CohubPulsePresentation(spaceName: state.spaceName, sessionTitle: state.sessionTitle)
}

private func statusText(
  _ state: CohubAgentPulseAttributes.ContentState,
  isStale: Bool
) -> String {
  if isStale { return "Stale" }
  switch pulseSnapshotFreshness(state) {
  case .known(.recovering): return "Recovering"
  case .known(.stale): return "Stale"
  case .known(.offline): return "Offline"
  case .invalid: return "Snapshot error"
  case .known(.live), .unavailable: return statusLabel(state.status)
  }
}

private func statusSymbol(
  _ state: CohubAgentPulseAttributes.ContentState,
  isStale: Bool
) -> String {
  if isStale { return "clock.badge.exclamationmark" }
  switch pulseSnapshotFreshness(state) {
  case .known(.recovering): return "arrow.trianglehead.2.clockwise.rotate.90"
  case .known(.stale): return "clock.badge.exclamationmark"
  case .known(.offline): return "wifi.exclamationmark"
  case .invalid: return "exclamationmark.triangle.fill"
  case .known(.live), .unavailable: break
  }
  switch state.status {
  case .queued: return "clock"
  case .running: return "waveform.path.ecg"
  case .abortRequested: return "stopwatch"
  case .completed, .merged: return "checkmark.circle.fill"
  case .failed: return "exclamationmark.triangle.fill"
  case .interrupted, .cancelled: return "stop.circle.fill"
  }
}

private func statusColor(
  _ state: CohubAgentPulseAttributes.ContentState,
  isStale: Bool
) -> Color {
  if isStale { return .secondary }
  switch pulseSnapshotFreshness(state) {
  case .known(.recovering): return .orange
  case .known(.stale): return .secondary
  case .known(.offline), .invalid: return .red
  case .known(.live), .unavailable: break
  }
  switch state.status {
  case .running: return .green
  case .queued, .abortRequested: return .orange
  case .completed, .merged: return .green
  case .failed: return .red
  case .interrupted, .cancelled: return .secondary
  }
}

private enum PulseSnapshotFreshness {
  case known(CohubFreshness)
  case unavailable
  case invalid
}

private func pulseSnapshotFreshness(
  _ state: CohubAgentPulseAttributes.ContentState
) -> PulseSnapshotFreshness {
  do {
    guard
      let snapshot = try CohubActivityStore().load(),
      snapshot.revision == state.revision,
      snapshot.primarySpaceId == state.spaceId,
      snapshot.primarySessionId == state.sessionId,
      snapshot.primarySpace?.origin == state.origin
    else {
      return .unavailable
    }
    return .known(snapshot.effectiveFreshness())
  } catch {
    return .invalid
  }
}
