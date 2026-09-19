@preconcurrency import ActivityKit
import Foundation

@MainActor
final class CohubActivityController {
  typealias EventHandler = ([String: Any]) -> Void

  private var eventHandler: EventHandler?
  private var pushToStartTask: Task<Void, Never>?
  private var activityTokenTasks: [String: Task<Void, Never>] = [:]
  private var activityStateTasks: [String: Task<Void, Never>] = [:]
  private var lastForegroundUpdates: [String: CohubActivityUpdateStamp] = [:]

  func setEventHandler(_ handler: @escaping EventHandler) {
    eventHandler = handler
  }

  func registerForPushTokens() {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      emit(type: "action.failed", fields: ["action": "push.register", "reason": "Live Activities are disabled"])
      return
    }

    observeExistingActivities()
    if #available(iOS 17.2, *) {
      if let token = Activity<CohubAgentPulseAttributes>.pushToStartToken {
        emitPushToStartToken(token)
      }
      guard pushToStartTask == nil else { return }
      pushToStartTask = Task { [weak self] in
        for await token in Activity<CohubAgentPulseAttributes>.pushToStartTokenUpdates {
          guard !Task.isCancelled else { return }
          guard let self else { return }
          self.emitPushToStartToken(token)
        }
      }
    }
  }

  func updateRunningActivity(with snapshot: CohubActivitySnapshot) async throws {
    guard let contentState = try snapshot.pulseContentState(nodeId: trustedNodeIdentifier()) else { return }
    guard let activity = Activity<CohubAgentPulseAttributes>.activities.first else { return }
    await update(activity, with: contentState)
  }

  func start(with snapshot: CohubActivitySnapshot) async throws {
    guard let contentState = try snapshot.pulseContentState(nodeId: trustedNodeIdentifier()) else {
      throw CohubActivityControllerError.missingPrimaryActivity
    }

    if let activity = Activity<CohubAgentPulseAttributes>.activities.first {
      await update(activity, with: contentState)
      return
    }

    let attributes = CohubAgentPulseAttributes(
      installationId: try installationIdentifier(),
      activityId: UUID()
    )
    let activity = try Activity.request(
      attributes: attributes,
      content: ActivityContent(state: contentState, staleDate: contentState.staleAt.date),
      pushType: .token
    )
    lastForegroundUpdates[activity.id] = contentState.updateStamp
    observe(activity)
  }

  func end() async throws {
    let activities = Activity<CohubAgentPulseAttributes>.activities
    guard !activities.isEmpty else { return }

    let snapshot: CohubActivitySnapshot?
    do {
      snapshot = try CohubActivityStore().load()
    } catch {
      await endImmediately(activities)
      throw error
    }
    let dismissalDate = Date().addingTimeInterval(105)
    for activity in activities {
      guard
        let snapshot,
        CohubActivityEndPolicy.shouldRetainFinalState(
          snapshot: snapshot,
          currentSpaceId: activity.content.state.spaceId,
          currentOrigin: activity.content.state.origin,
          currentSessionId: activity.content.state.sessionId,
          currentTurnId: activity.content.state.turnId
        ),
        let projectedState = try snapshot.pulseContentState(nodeId: trustedNodeIdentifier())
      else {
        stopObserving(activity)
        await activity.end(nil, dismissalPolicy: .immediate)
        continue
      }
      let finalContent = ActivityContent(
        state: projectedState,
        staleDate: projectedState.staleAt.date
      )
      lastForegroundUpdates.removeValue(forKey: activity.id)
      await activity.end(finalContent, dismissalPolicy: .after(dismissalDate))
    }
  }

  func reset() async {
    for activity in Activity<CohubAgentPulseAttributes>.activities {
      stopObserving(activity)
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  func notifyStateResetCompleted() {
    emit(type: "state.reset.completed")
  }

  private func update(
    _ activity: Activity<CohubAgentPulseAttributes>,
    with contentState: CohubAgentPulseAttributes.ContentState
  ) async {
    let currentStamp = activity.content.state.updateStamp
    guard CohubActivityUpdateOrder.shouldApply(
      incoming: contentState.updateStamp,
      current: currentStamp,
      lastForeground: lastForegroundUpdates[activity.id]
    ) else { return }

    lastForegroundUpdates[activity.id] = contentState.updateStamp
    observe(activity)
    await activity.update(
      ActivityContent(state: contentState, staleDate: contentState.staleAt.date)
    )
  }

  private func endImmediately(
    _ activities: [Activity<CohubAgentPulseAttributes>]
  ) async {
    for activity in activities {
      stopObserving(activity)
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  private func stopObserving(_ activity: Activity<CohubAgentPulseAttributes>) {
    activityTokenTasks.removeValue(forKey: activity.id)?.cancel()
    activityStateTasks.removeValue(forKey: activity.id)?.cancel()
    lastForegroundUpdates.removeValue(forKey: activity.id)
  }

  private func observeExistingActivities() {
    for activity in Activity<CohubAgentPulseAttributes>.activities {
      observe(activity)
    }
  }

  private func observe(_ activity: Activity<CohubAgentPulseAttributes>) {
    if let token = activity.pushToken {
      emitActivityToken(token, activity: activity)
    }
    if activityTokenTasks[activity.id] == nil {
      activityTokenTasks[activity.id] = Task { [weak self] in
        for await token in activity.pushTokenUpdates {
          guard !Task.isCancelled else { return }
          guard let self else { return }
          self.emitActivityToken(token, activity: activity)
        }
      }
    }

    if activityStateTasks[activity.id] == nil {
      activityStateTasks[activity.id] = Task { [weak self] in
        for await state in activity.activityStateUpdates {
          guard !Task.isCancelled else { return }
          guard state == .dismissed else { continue }
          self?.emit(
            type: "activity.dismissed",
            fields: [
              "installationId": activity.attributes.installationId.uuidString.lowercased(),
              "activityId": activity.attributes.activityId.uuidString.lowercased(),
            ]
          )
          self?.stopObserving(activity)
          return
        }
      }
    }
  }

  private func installationIdentifier() throws -> UUID {
    guard let defaults = UserDefaults(suiteName: CohubActivityStore.appGroupIdentifier) else {
      throw CohubActivityStoreError.appGroupUnavailable
    }
    if
      let value = defaults.string(forKey: "installation-id"),
      let identifier = UUID(uuidString: value)
    {
      return identifier
    }
    let identifier = UUID()
    defaults.set(identifier.uuidString.lowercased(), forKey: "installation-id")
    return identifier
  }

  private func trustedNodeIdentifier() throws -> String {
    guard
      let identifier = Bundle.main.object(forInfoDictionaryKey: "CohubRelayNodeId") as? String,
      (try? CohubIdentifier.validate(identifier)) != nil
    else {
      throw CohubActivityControllerError.missingTrustedNodeIdentifier
    }
    return identifier
  }

  private func pushEnvironment() throws -> CohubPushEnvironment {
    guard
      let value = Bundle.main.object(forInfoDictionaryKey: "CohubPushEnvironment") as? String,
      let environment = CohubPushEnvironment(rawValue: value)
    else {
      throw CohubActivityControllerError.missingPushEnvironment
    }
    return environment
  }

  private func emitPushToStartToken(_ token: Data) {
    do {
      emit(
        type: "pushToStartToken.changed",
        fields: [
          "installationId": try installationIdentifier().uuidString.lowercased(),
          "token": token.hexEncodedString,
          "environment": try pushEnvironment().rawValue,
        ]
      )
    } catch {
      emit(
        type: "action.failed",
        fields: ["action": "push.register", "reason": error.localizedDescription]
      )
    }
  }

  private func emitActivityToken(
    _ token: Data,
    activity: Activity<CohubAgentPulseAttributes>
  ) {
    do {
      emit(
        type: "activityPushToken.changed",
        fields: [
          "installationId": activity.attributes.installationId.uuidString.lowercased(),
          "activityId": activity.attributes.activityId.uuidString.lowercased(),
          "token": token.hexEncodedString,
          "environment": try pushEnvironment().rawValue,
        ]
      )
    } catch {
      emit(
        type: "action.failed",
        fields: ["action": "push.register", "reason": error.localizedDescription]
      )
    }
  }

  private func emit(type: String, fields: [String: Any] = [:]) {
    var detail: [String: Any] = ["schemaVersion": 1, "type": type]
    detail.merge(fields) { _, new in new }
    eventHandler?(detail)
  }
}

enum CohubActivityControllerError: Error {
  case missingPrimaryActivity
  case missingTrustedNodeIdentifier
  case missingPushEnvironment
}

extension Data {
  fileprivate var hexEncodedString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
