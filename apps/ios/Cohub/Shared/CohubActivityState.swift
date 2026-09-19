import Foundation

enum CohubActivityStateError: Error, Equatable, CustomStringConvertible {
  case unsupportedSchemaVersion(Int)
  case invalidRevision(Int64)
  case invalidTimestamp(String)
  case invalidIdentifier(String)
  case invalidDisplayName(String)
  case invalidCount(String)
  case duplicateSpace(String)
  case inconsistentPrimarySpace
  case inconsistentPrimarySession
  case invalidActivityTimeRange

  var description: String {
    switch self {
    case .unsupportedSchemaVersion(let version):
      return "Unsupported schema version: \(version)"
    case .invalidRevision(let revision):
      return "Invalid revision: \(revision)"
    case .invalidTimestamp(let value):
      return "Invalid timestamp: \(value)"
    case .invalidIdentifier(let value):
      return "Invalid identifier: \(value)"
    case .invalidDisplayName(let field):
      return "Invalid display name: \(field)"
    case .invalidCount(let field):
      return "Invalid count: \(field)"
    case .duplicateSpace(let identifier):
      return "Duplicate Space: \(identifier)"
    case .inconsistentPrimarySpace:
      return "Primary Space does not match the snapshot"
    case .inconsistentPrimarySession:
      return "Primary Session does not match the snapshot"
    case .invalidActivityTimeRange:
      return "Activity update precedes its start"
    }
  }
}

struct CohubTimestamp: Codable, Hashable, Comparable, Sendable {
  let date: Date

  init(_ date: Date) {
    self.date = date
  }

  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    guard let date = Self.parse(value) else {
      throw CohubActivityStateError.invalidTimestamp(value)
    }
    self.date = date
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(Self.format(date))
  }

  static func < (lhs: CohubTimestamp, rhs: CohubTimestamp) -> Bool {
    lhs.date < rhs.date
  }

  private static func parse(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }

    let wholeSeconds = ISO8601DateFormatter()
    wholeSeconds.formatOptions = [.withInternetDateTime]
    return wholeSeconds.date(from: value)
  }

  private static func format(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}

enum CohubFreshness: String, Codable, Hashable, Sendable {
  case live
  case recovering
  case stale
  case offline
}

enum CohubPushEnvironment: String, Codable, Hashable, Sendable {
  case development
  case production
}

enum CohubSpaceOrigin: String, Codable, Hashable, Sendable {
  case cloud
  case local
}

enum CohubTurnStatus: String, Codable, Hashable, Sendable {
  case queued
  case running
  case abortRequested = "abort_requested"
  case completed
  case failed
  case interrupted
  case merged
  case cancelled

  var isTerminal: Bool {
    switch self {
    case .completed, .failed, .interrupted, .merged, .cancelled:
      return true
    case .queued, .running, .abortRequested:
      return false
    }
  }
}

enum CohubActivityPhase: String, Codable, Hashable, Sendable {
  case dispatching
  case working
  case waitingModel = "waiting_model"
  case stopping
  case finished
  case error
}

struct CohubSessionActivity: Codable, Hashable, Sendable {
  let sessionId: String
  let sessionTitle: String
  let turnId: String
  let status: CohubTurnStatus
  let phase: CohubActivityPhase
  let harness: String?
  let model: String?
  let summary: String?
  let startedAt: CohubTimestamp
  let updatedAt: CohubTimestamp
  let errorMessage: String?

  func validate() throws {
    try CohubIdentifier.validate(sessionId)
    try CohubIdentifier.validate(turnId)
    try CohubDisplayName.validate(sessionTitle, field: "sessionTitle")
    guard updatedAt >= startedAt else {
      throw CohubActivityStateError.invalidActivityTimeRange
    }
  }
}

struct CohubSpaceActivity: Codable, Hashable, Sendable {
  let spaceId: String
  let spaceName: String
  let origin: CohubSpaceOrigin
  let isPrimary: Bool
  let activeAgentCount: Int
  let attentionCount: Int
  let activity: CohubSessionActivity?

  func validate() throws {
    try CohubIdentifier.validate(spaceId)
    try CohubDisplayName.validate(spaceName, field: "spaceName")
    guard activeAgentCount >= 0 else {
      throw CohubActivityStateError.invalidCount("activeAgentCount")
    }
    guard attentionCount >= 0 else {
      throw CohubActivityStateError.invalidCount("attentionCount")
    }
    try activity?.validate()
  }
}

struct CohubActivitySnapshot: Codable, Hashable, Sendable {
  static let schemaVersion = 1
  static let nativeFreshnessInterval: TimeInterval = 5 * 60

  let schemaVersion: Int
  let revision: Int64
  let generatedAt: CohubTimestamp
  let freshness: CohubFreshness
  let primarySpaceId: String?
  let primarySessionId: String?
  let otherActiveCount: Int
  let boardSpaceIds: [String]
  let spaces: [CohubSpaceActivity]

  func validate() throws {
    guard schemaVersion == Self.schemaVersion else {
      throw CohubActivityStateError.unsupportedSchemaVersion(schemaVersion)
    }
    guard revision >= 0 else {
      throw CohubActivityStateError.invalidRevision(revision)
    }
    if let primarySpaceId { try CohubIdentifier.validate(primarySpaceId) }
    if let primarySessionId { try CohubIdentifier.validate(primarySessionId) }
    guard otherActiveCount >= 0 else {
      throw CohubActivityStateError.invalidCount("otherActiveCount")
    }
    guard boardSpaceIds.count <= 3 else {
      throw CohubActivityStateError.invalidCount("boardSpaceIds")
    }

    var spaceIds = Set<String>()
    for space in spaces {
      try space.validate()
      guard spaceIds.insert(space.spaceId).inserted else {
        throw CohubActivityStateError.duplicateSpace(space.spaceId)
      }
    }

    var boardIds = Set<String>()
    for boardSpaceId in boardSpaceIds {
      try CohubIdentifier.validate(boardSpaceId)
      guard boardIds.insert(boardSpaceId).inserted else {
        throw CohubActivityStateError.duplicateSpace(boardSpaceId)
      }
      guard spaceIds.contains(boardSpaceId) else {
        throw CohubActivityStateError.invalidIdentifier(boardSpaceId)
      }
    }

    let markedPrimary = spaces.filter(\.isPrimary)
    if let primarySpaceId {
      guard markedPrimary.count == 1, markedPrimary[0].spaceId == primarySpaceId else {
        throw CohubActivityStateError.inconsistentPrimarySpace
      }
    } else if !markedPrimary.isEmpty {
      throw CohubActivityStateError.inconsistentPrimarySpace
    }

    if let primarySessionId {
      guard
        let primarySpaceId,
        let primarySpace = spaces.first(where: { $0.spaceId == primarySpaceId }),
        primarySpace.activity?.sessionId == primarySessionId
      else {
        throw CohubActivityStateError.inconsistentPrimarySession
      }
    }
  }

  func effectiveFreshness(at date: Date = Date()) -> CohubFreshness {
    guard freshness == .live else { return freshness }
    return date.timeIntervalSince(generatedAt.date) >= Self.nativeFreshnessInterval ? .stale : .live
  }

  var primarySpace: CohubSpaceActivity? {
    guard let primarySpaceId else { return nil }
    return spaces.first(where: { $0.spaceId == primarySpaceId })
  }

  var primaryActivity: CohubSessionActivity? {
    primarySpace?.activity
  }

  var primaryActivityEventAt: CohubTimestamp? {
    primaryActivity?.updatedAt
  }

  var primaryActivityStaleAt: Date? {
    primaryActivityEventAt?.date.addingTimeInterval(Self.nativeFreshnessInterval)
  }

  var boardSpaces: [CohubSpaceActivity] {
    boardSpaceIds.compactMap { boardId in
      spaces.first(where: { $0.spaceId == boardId })
    }
  }

  var staleAt: Date {
    generatedAt.date.addingTimeInterval(Self.nativeFreshnessInterval)
  }
}

enum CohubIdentifier {
  static func validate(_ identifier: String) throws {
    guard !identifier.isEmpty,
      identifier.unicodeScalars.allSatisfy({
        CharacterSet.alphanumerics.contains($0) || "-._~".unicodeScalars.contains($0)
      })
    else {
      throw CohubActivityStateError.invalidIdentifier(identifier)
    }
  }
}

enum CohubDisplayName {
  static let maximumUnicodeScalarCount = 255
  static let maximumUTF8Length = maximumUnicodeScalarCount * 4

  static func validate(_ value: String, field: String) throws {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      !trimmed.isEmpty,
      value.unicodeScalars.count <= maximumUnicodeScalarCount,
      value.utf8.count <= maximumUTF8Length,
      value.unicodeScalars.allSatisfy({ scalar in
        !isForbiddenControl(scalar)
      })
    else {
      throw CohubActivityStateError.invalidDisplayName(field)
    }
  }

  private static func isForbiddenControl(_ scalar: UnicodeScalar) -> Bool {
    let value = scalar.value
    return value <= 0x1F
      || (0x7F...0x9F).contains(value)
      || value == 0x2028
      || value == 0x2029
  }
}

struct CohubActivityUpdateStamp: Equatable, Sendable {
  let generatedAt: CohubTimestamp
  let revision: Int64
}

enum CohubActivityUpdateOrder {
  static func shouldApply(
    incoming: CohubActivityUpdateStamp,
    current: CohubActivityUpdateStamp,
    lastForeground: CohubActivityUpdateStamp?
  ) -> Bool {
    if incoming.generatedAt != current.generatedAt {
      return incoming.generatedAt > current.generatedAt
    }
    guard lastForeground == current else { return false }
    return incoming.revision > current.revision
  }
}

enum CohubActivityEndPolicy {
  static func shouldRetainFinalState(
    snapshot: CohubActivitySnapshot,
    currentSpaceId: String,
    currentOrigin: CohubSpaceOrigin,
    currentSessionId: String,
    currentTurnId: String
  ) -> Bool {
    guard let space = snapshot.primarySpace, let activity = space.activity else { return false }
    return space.spaceId == currentSpaceId
      && space.origin == currentOrigin
      && activity.sessionId == currentSessionId
      && activity.turnId == currentTurnId
      && activity.status.isTerminal
  }
}

enum CohubDeepLink {
  static func space(_ spaceId: String, origin: CohubSpaceOrigin) -> URL? {
    guard (try? CohubIdentifier.validate(spaceId)) != nil else { return nil }
    var components = URLComponents()
    components.scheme = "cohub"
    components.host = "spaces"
    components.path = "/\(spaceId)"
    components.queryItems = [URLQueryItem(name: "origin", value: origin.rawValue)]
    return components.url
  }

  static func session(
    spaceId: String,
    sessionId: String,
    origin: CohubSpaceOrigin,
    turnSequence: Int? = nil
  ) -> URL? {
    guard
      (try? CohubIdentifier.validate(spaceId)) != nil,
      (try? CohubIdentifier.validate(sessionId)) != nil,
      turnSequence.map({ $0 >= 0 }) ?? true
    else { return nil }

    var components = URLComponents()
    components.scheme = "cohub"
    components.host = "spaces"
    components.path = "/\(spaceId)/sessions/\(sessionId)"
    components.queryItems = [URLQueryItem(name: "origin", value: origin.rawValue)]
    if let turnSequence {
      components.queryItems?.append(URLQueryItem(name: "turn", value: String(turnSequence)))
    }
    return components.url
  }
}
