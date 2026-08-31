import Foundation
import WebKit
import WidgetKit

enum CohubBridgeMessageType: String {
  case snapshotReplace = "snapshot.replace"
  case focusReplace = "focus.replace"
  case activityStart = "activity.start"
  case activityEnd = "activity.end"
  case pushRegister = "push.register"
  case stateReset = "state.reset"
}

enum CohubActivityBridgeError: Error, CustomStringConvertible {
  case invalidEnvelope
  case unsupportedSchemaVersion
  case unsupportedMessage
  case unexpectedPayload
  case missingSnapshot

  var description: String {
    switch self {
    case .invalidEnvelope: return "Invalid native activity message"
    case .unsupportedSchemaVersion: return "Unsupported native activity schema"
    case .unsupportedMessage: return "Unsupported native activity message"
    case .unexpectedPayload: return "Native activity message contains unsupported fields"
    case .missingSnapshot: return "Native activity message requires a complete snapshot"
    }
  }
}

@MainActor
final class CohubActivityBridge {
  private let controller: CohubActivityController
  private let decoder = JSONDecoder()

  init(controller: CohubActivityController) {
    self.controller = controller
  }

  func receive(_ message: WKScriptMessage) async throws {
    guard
      message.frameInfo.isMainFrame,
      CohubOriginPolicy.isTrustedSecurityOrigin(
        scheme: message.frameInfo.securityOrigin.protocol,
        host: message.frameInfo.securityOrigin.host,
        port: message.frameInfo.securityOrigin.port
      )
    else {
      throw CohubActivityBridgeError.invalidEnvelope
    }
    guard let envelope = message.body as? [String: Any] else {
      throw CohubActivityBridgeError.invalidEnvelope
    }
    guard (envelope["schemaVersion"] as? NSNumber)?.intValue == 1 else {
      throw CohubActivityBridgeError.unsupportedSchemaVersion
    }
    guard
      let rawType = envelope["type"] as? String,
      let type = CohubBridgeMessageType(rawValue: rawType)
    else {
      throw CohubActivityBridgeError.unsupportedMessage
    }

    let snapshotTypes: Set<CohubBridgeMessageType> = [.snapshotReplace, .focusReplace, .activityStart]
    let allowedKeys: Set<String> = snapshotTypes.contains(type)
      ? ["schemaVersion", "type", "snapshot"]
      : ["schemaVersion", "type"]
    guard Set(envelope.keys) == allowedKeys else {
      throw snapshotTypes.contains(type) && envelope["snapshot"] == nil
        ? CohubActivityBridgeError.missingSnapshot
        : CohubActivityBridgeError.unexpectedPayload
    }

    switch type {
    case .snapshotReplace, .focusReplace, .activityStart:
      guard let rawSnapshot = envelope["snapshot"] else {
        throw CohubActivityBridgeError.missingSnapshot
      }
      let data = try JSONSerialization.data(withJSONObject: rawSnapshot)
      let incoming = try decoder.decode(CohubActivitySnapshot.self, from: data)
      try incoming.validate()
      let snapshot = try persistOrLoadAuthoritative(incoming)
      WidgetCenter.shared.reloadTimelines(ofKind: "CohubFocusBoard")

      if type == .activityStart {
        try await controller.start(with: snapshot)
      } else {
        try await controller.updateRunningActivity(with: snapshot)
      }

    case .activityEnd:
      try await controller.end()

    case .pushRegister:
      controller.registerForPushTokens()

    case .stateReset:
      await controller.reset()
      try CohubActivityStore().reset()
      WidgetCenter.shared.reloadTimelines(ofKind: "CohubFocusBoard")
      controller.notifyStateResetCompleted()
    }
  }

  private func persistOrLoadAuthoritative(
    _ incoming: CohubActivitySnapshot
  ) throws -> CohubActivitySnapshot {
    let store = try CohubActivityStore()
    do {
      try store.replace(with: incoming)
      return incoming
    } catch CohubActivityStoreError.duplicateOrOutOfOrder {
      guard let current = try store.load() else {
        throw CohubActivityBridgeError.invalidEnvelope
      }
      return current
    }
  }
}
