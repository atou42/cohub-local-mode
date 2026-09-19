import ActivityKit
import Foundation

struct CohubAgentPulseAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let schemaVersion: Int
    let revision: Int64
    let generatedAt: CohubTimestamp
    let staleAt: CohubTimestamp
    let nodeId: String
    let spaceId: String
    let spaceName: String
    let origin: CohubSpaceOrigin
    let sessionId: String
    let sessionTitle: String
    let turnId: String
    let status: CohubTurnStatus
    let otherActiveCount: Int

    init(
      schemaVersion: Int,
      revision: Int64,
      generatedAt: CohubTimestamp,
      staleAt: CohubTimestamp,
      nodeId: String,
      spaceId: String,
      spaceName: String,
      origin: CohubSpaceOrigin,
      sessionId: String,
      sessionTitle: String,
      turnId: String,
      status: CohubTurnStatus,
      otherActiveCount: Int
    ) throws {
      self.schemaVersion = schemaVersion
      self.revision = revision
      self.generatedAt = generatedAt
      self.staleAt = staleAt
      self.nodeId = nodeId
      self.spaceId = spaceId
      self.spaceName = spaceName
      self.origin = origin
      self.sessionId = sessionId
      self.sessionTitle = sessionTitle
      self.turnId = turnId
      self.status = status
      self.otherActiveCount = otherActiveCount
      try validate()
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
      revision = try container.decode(Int64.self, forKey: .revision)
      generatedAt = try container.decode(CohubTimestamp.self, forKey: .generatedAt)
      staleAt = try container.decode(CohubTimestamp.self, forKey: .staleAt)
      nodeId = try container.decode(String.self, forKey: .nodeId)
      spaceId = try container.decode(String.self, forKey: .spaceId)
      spaceName = try container.decode(String.self, forKey: .spaceName)
      origin = try container.decode(CohubSpaceOrigin.self, forKey: .origin)
      sessionId = try container.decode(String.self, forKey: .sessionId)
      sessionTitle = try container.decode(String.self, forKey: .sessionTitle)
      turnId = try container.decode(String.self, forKey: .turnId)
      status = try container.decode(CohubTurnStatus.self, forKey: .status)
      otherActiveCount = try container.decode(Int.self, forKey: .otherActiveCount)
      try validate()
    }

    func validate() throws {
      guard schemaVersion == CohubActivitySnapshot.schemaVersion else {
        throw CohubActivityStateError.unsupportedSchemaVersion(schemaVersion)
      }
      guard revision >= 0 else { throw CohubActivityStateError.invalidRevision(revision) }
      try CohubIdentifier.validate(nodeId)
      try CohubIdentifier.validate(spaceId)
      try CohubDisplayName.validate(spaceName, field: "spaceName")
      try CohubIdentifier.validate(sessionId)
      try CohubDisplayName.validate(sessionTitle, field: "sessionTitle")
      try CohubIdentifier.validate(turnId)
      guard staleAt >= generatedAt else {
        throw CohubActivityStateError.invalidActivityTimeRange
      }
      guard otherActiveCount >= 0 else {
        throw CohubActivityStateError.invalidCount("otherActiveCount")
      }
    }

    var sessionURL: URL? {
      CohubDeepLink.session(spaceId: spaceId, sessionId: sessionId, origin: origin)
    }

    var updateStamp: CohubActivityUpdateStamp {
      CohubActivityUpdateStamp(generatedAt: generatedAt, revision: revision)
    }
  }

  let installationId: UUID
  let activityId: UUID
}

extension CohubActivitySnapshot {
  func pulseContentState(nodeId: String) throws -> CohubAgentPulseAttributes.ContentState? {
    guard let space = primarySpace, let activity = space.activity else { return nil }
    let eventAt = activity.updatedAt
    return try CohubAgentPulseAttributes.ContentState(
      schemaVersion: Self.schemaVersion,
      revision: revision,
      generatedAt: eventAt,
      staleAt: CohubTimestamp(eventAt.date.addingTimeInterval(Self.nativeFreshnessInterval)),
      nodeId: nodeId,
      spaceId: space.spaceId,
      spaceName: space.spaceName,
      origin: space.origin,
      sessionId: activity.sessionId,
      sessionTitle: activity.sessionTitle,
      turnId: activity.turnId,
      status: activity.status,
      otherActiveCount: otherActiveCount
    )
  }
}
