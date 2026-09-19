import Foundation

enum CohubActivityStoreError: Error, Equatable {
  case appGroupUnavailable
  case duplicateOrOutOfOrder(current: Int64, received: Int64)
}

struct CohubActivityStore: Sendable {
  static let appGroupIdentifier = "group.cc.atou.cohub.shared"
  static let snapshotFilename = "activity-snapshot.json"

  private let snapshotURL: URL
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  init(fileManager: FileManager = .default) throws {
    guard
      let containerURL = fileManager.containerURL(
        forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier)
    else {
      throw CohubActivityStoreError.appGroupUnavailable
    }
    self.snapshotURL = containerURL.appendingPathComponent(Self.snapshotFilename, isDirectory: false)
  }

  init(snapshotURL: URL) {
    self.snapshotURL = snapshotURL
  }

  func load() throws -> CohubActivitySnapshot? {
    guard FileManager.default.fileExists(atPath: snapshotURL.path) else { return nil }
    let snapshot = try decoder.decode(CohubActivitySnapshot.self, from: Data(contentsOf: snapshotURL))
    try snapshot.validate()
    return snapshot
  }

  @discardableResult
  func replace(with snapshot: CohubActivitySnapshot) throws -> Bool {
    try snapshot.validate()
    if let current = try load(), snapshot.revision <= current.revision {
      throw CohubActivityStoreError.duplicateOrOutOfOrder(
        current: current.revision,
        received: snapshot.revision
      )
    }

    let data = try encoder.encode(snapshot)
    try data.write(to: snapshotURL, options: [.atomic])
    return true
  }

  func reset() throws {
    guard FileManager.default.fileExists(atPath: snapshotURL.path) else { return }
    try FileManager.default.removeItem(at: snapshotURL)
  }
}
