import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  }
}

private func expectThrows(_ message: String, _ operation: () throws -> Void) {
  do {
    try operation()
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  } catch {}
}

private func makeValidSnapshotJSON() -> String {
  """
  {
    "schemaVersion": 1,
    "revision": 42,
    "generatedAt": "2026-08-31T10:00:05.000Z",
    "freshness": "live",
    "primarySpaceId": "space-focus",
    "primarySessionId": "session-1",
    "otherActiveCount": 2,
    "boardSpaceIds": ["space-board"],
    "spaces": [
      {
        "spaceId": "space-board",
        "spaceName": "Pinned Space",
        "origin": "cloud",
        "isPrimary": false,
        "activeAgentCount": 0,
        "attentionCount": 0,
        "activity": null
      },
      {
        "spaceId": "space-focus",
        "spaceName": "Focused Space",
        "origin": "local",
        "isPrimary": true,
        "activeAgentCount": 1,
        "attentionCount": 0,
        "activity": {
          "sessionId": "session-1",
          "sessionTitle": "Ship Focus Board",
          "turnId": "turn-1",
          "status": "running",
          "phase": "working",
          "harness": null,
          "model": null,
          "summary": null,
          "startedAt": "2026-08-31T09:58:00.000Z",
          "updatedAt": "2026-08-31T10:00:00.000Z",
          "errorMessage": null
        }
      }
    ]
  }
  """
}

@main
struct CohubNativeLogicTests {
  static func main() throws {
    let decoder = JSONDecoder()
    let validSnapshotJSON = makeValidSnapshotJSON()
    let validData = Data(validSnapshotJSON.utf8)
    let snapshot = try decoder.decode(CohubActivitySnapshot.self, from: validData)
    try snapshot.validate()
    expect(snapshot.boardSpaces.map(\.spaceId) == ["space-board"], "board order is explicit")
    expect(snapshot.primarySpace?.spaceId == "space-focus", "Pulse focus is independent of board")
    expect(snapshot.primaryActivity?.harness == nil, "nullable harness remains unknown")
    expect(snapshot.primaryActivity?.model == nil, "nullable model remains unknown")
    expect(snapshot.primaryActivity?.summary == nil, "nullable summary remains unknown")
    expect(snapshot.primaryActivity?.status.isTerminal == false, "running status is not terminal")
    expect(
      snapshot.generatedAt.date.timeIntervalSince(snapshot.primaryActivityEventAt!.date) == 5,
      "snapshot generation time may be later than the authoritative Turn event"
    )
    expect(
      snapshot.primaryActivityEventAt?.date == snapshot.primaryActivity?.updatedAt.date,
      "Pulse ordering uses the authoritative Turn update time"
    )
    expect(
      snapshot.primaryActivityStaleAt
        == snapshot.primaryActivityEventAt?.date.addingTimeInterval(
          CohubActivitySnapshot.nativeFreshnessInterval),
      "Pulse staleness is measured from the authoritative Turn update time"
    )

    let terminalJSON = validSnapshotJSON.replacingOccurrences(
      of: "\"running\"",
      with: "\"failed\""
    )
    let terminalSnapshot = try decoder.decode(
      CohubActivitySnapshot.self,
      from: Data(terminalJSON.utf8)
    )
    try terminalSnapshot.validate()
    expect(terminalSnapshot.primaryActivity?.status.isTerminal == true, "failed status is terminal")

    let badEnum = validSnapshotJSON.replacingOccurrences(of: "\"running\"", with: "\"thinking\"")
    expectThrows("unknown status enum is rejected") {
      _ = try decoder.decode(CohubActivitySnapshot.self, from: Data(badEnum.utf8))
    }

    let badOrigin = validSnapshotJSON.replacingOccurrences(of: "\"local\"", with: "\"hybrid\"")
    expectThrows("unknown Space origin is rejected") {
      _ = try decoder.decode(CohubActivitySnapshot.self, from: Data(badOrigin.utf8))
    }

    let badTimestamp = validSnapshotJSON.replacingOccurrences(
      of: "2026-08-31T10:00:00.000Z",
      with: "not-a-time"
    )
    expectThrows("malformed timestamp is rejected") {
      _ = try decoder.decode(CohubActivitySnapshot.self, from: Data(badTimestamp.utf8))
    }

    let temporaryDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporaryDirectory) }
    let store = CohubActivityStore(
      snapshotURL: temporaryDirectory.appendingPathComponent("snapshot.json")
    )
    try store.replace(with: snapshot)
    expectThrows("duplicate revision is rejected") {
      try store.replace(with: snapshot)
    }
    try store.reset()
    let clearedSnapshot = try store.load()
    expect(clearedSnapshot == nil, "state reset removes the shared snapshot")
    try store.replace(with: snapshot)
    let resetSnapshot = try store.load()
    expect(resetSnapshot?.revision == 42, "state reset clears the installed revision")

    expect(
      CohubPushEnvironment(rawValue: "development") == .development,
      "development push environment is accepted"
    )
    expect(
      CohubPushEnvironment(rawValue: "production") == .production,
      "production push environment is accepted"
    )
    expect(
      CohubPushEnvironment(rawValue: "sandbox") == nil,
      "unsupported push environment is rejected"
    )

    let emptyNameJSON = validSnapshotJSON.replacingOccurrences(
      of: "\"Ship Focus Board\"",
      with: "\"\""
    )
    expectThrows("empty push display name is rejected") {
      let invalidName = try decoder.decode(
        CohubActivitySnapshot.self,
        from: Data(emptyNameJSON.utf8)
      )
      try invalidName.validate()
    }

    let maximumScalarName = String(repeating: "\u{1F680}", count: 255)
    try CohubDisplayName.validate(maximumScalarName, field: "maximumScalarName")
    expect(maximumScalarName.utf8.count == 1020, "255 four-byte scalars fit the database limit")
    expectThrows("more than 255 Unicode scalars is rejected") {
      try CohubDisplayName.validate(String(repeating: "a", count: 256), field: "tooLong")
    }
    try CohubDisplayName.validate("team\u{200D}name", field: "formatScalar")
    for forbidden in ["\u{0000}", "\u{0085}", "\u{2028}", "\u{2029}"] {
      expectThrows("forbidden display-name controls are rejected") {
        try CohubDisplayName.validate("name\(forbidden)", field: "forbiddenControl")
      }
    }

    let boardLink = CohubDeepLink.space("space-1", origin: .local)!
    expect(
      CohubNavigationPolicy.resolvedURL(for: boardLink)
        == URL(string: "https://cohub.atou.cc/spaces/space-1?origin=local")!,
      "local Space deep link preserves its origin"
    )

    let sessionLink = CohubDeepLink.session(
      spaceId: "space-1",
      sessionId: "session-2",
      origin: .cloud,
      turnSequence: 3
    )!
    expect(
      CohubNavigationPolicy.resolvedURL(for: sessionLink)
        == URL(string: "https://cohub.atou.cc/spaces/space-1/sessions/session-2?origin=cloud&turn=3")!,
      "cloud Session deep link preserves origin and turn"
    )

    let invalidDeepLinks = [
      "cohub://spaces/space-1",
      "cohub://spaces/space-1?origin=unknown",
      "cohub://spaces/space-1?origin=local&origin=cloud",
      "cohub://spaces/space-1?origin=local&extra=true",
      "cohub://spaces/space-1?origin=local&turn=3",
      "cohub://spaces/space-1/sessions/session-2?origin=local&turn=-1",
      "cohub://spaces/space-1/sessions/session-2?origin=local&turn=03",
      "cohub://spaces/space-1/sessions/session-2?origin=local&turn=3&turn=4",
    ]
    for invalidDeepLink in invalidDeepLinks {
      expect(
        CohubNavigationPolicy.resolvedURL(for: URL(string: invalidDeepLink)!) == nil,
        "malformed or ambiguous origin query fails closed"
      )
    }

    expect(
      CohubNavigationPolicy.resolvedURL(for: URL(string: "cohub://spaces/space-1/files/private")!)
        == nil,
      "unsupported Cohub route fails closed"
    )
    expect(
      CohubNavigationPolicy.resolvedURL(for: URL(string: "cohub://spaces")!) == nil,
      "missing deep-link identifier fails closed"
    )
    expect(
      CohubNavigationPolicy.resolvedURL(for: URL(string: "https://example.com/spaces/space-1")!)
        == nil,
      "cross-origin web URL fails closed"
    )

    let defaultPort = URL(string: "https://cohub.atou.cc/spaces/space-1")!
    let explicitHTTPSPort = URL(string: "https://cohub.atou.cc:443/spaces/space-1")!
    let nonDefaultPort = URL(string: "https://cohub.atou.cc:8443/spaces/space-1")!
    let insecureOrigin = URL(string: "http://cohub.atou.cc/spaces/space-1")!
    let externalOrigin = URL(string: "https://example.com/spaces/space-1")!

    expect(CohubOriginPolicy.isTrusted(defaultPort), "default HTTPS Cohub origin is trusted")
    expect(CohubOriginPolicy.isTrusted(explicitHTTPSPort), "explicit port 443 is trusted")
    expect(!CohubOriginPolicy.isTrusted(nonDefaultPort), "same host on non-443 port is rejected")
    expect(!CohubOriginPolicy.isTrusted(insecureOrigin), "HTTP Cohub origin is rejected")
    expect(!CohubOriginPolicy.isTrusted(externalOrigin), "external HTTPS origin is rejected")
    expect(
      CohubOriginPolicy.isTrustedSecurityOrigin(
        scheme: "https", host: "cohub.atou.cc", port: 0),
      "WebKit's omitted default port representation is trusted"
    )
    expect(
      !CohubOriginPolicy.isTrustedSecurityOrigin(
        scheme: "https", host: "cohub.atou.cc", port: 8443),
      "WebKit non-default port is rejected"
    )

    let olderTimestamp = CohubActivityUpdateStamp(
      generatedAt: CohubTimestamp(Date(timeIntervalSince1970: 100)),
      revision: 999
    )
    let currentTimestamp = CohubActivityUpdateStamp(
      generatedAt: CohubTimestamp(Date(timeIntervalSince1970: 200)),
      revision: 10
    )
    let newerTimestamp = CohubActivityUpdateStamp(
      generatedAt: CohubTimestamp(Date(timeIntervalSince1970: 300)),
      revision: 1
    )
    let sameSourceNewerRevision = CohubActivityUpdateStamp(
      generatedAt: currentTimestamp.generatedAt,
      revision: 11
    )
    expect(
      !CohubActivityUpdateOrder.shouldApply(
        incoming: olderTimestamp, current: currentTimestamp, lastForeground: currentTimestamp),
      "an older foreground timestamp cannot overwrite a newer APNs state"
    )
    expect(
      CohubActivityUpdateOrder.shouldApply(
        incoming: newerTimestamp, current: currentTimestamp, lastForeground: nil),
      "a newer foreground timestamp replaces current state"
    )
    expect(
      CohubActivityUpdateOrder.shouldApply(
        incoming: sameSourceNewerRevision,
        current: currentTimestamp,
        lastForeground: currentTimestamp
      ),
      "revision advances a state last written by the foreground source"
    )
    expect(
      !CohubActivityUpdateOrder.shouldApply(
        incoming: sameSourceNewerRevision,
        current: currentTimestamp,
        lastForeground: nil
      ),
      "revision alone cannot overwrite a state received from APNs"
    )

    let reconciledForeground = CohubActivityUpdateStamp(
      generatedAt: snapshot.primaryActivityEventAt!,
      revision: snapshot.revision
    )
    let terminalAPNs = CohubActivityUpdateStamp(
      generatedAt: CohubTimestamp(
        snapshot.primaryActivityEventAt!.date.addingTimeInterval(1)),
      revision: snapshot.revision + 1
    )
    expect(
      !CohubActivityUpdateOrder.shouldApply(
        incoming: reconciledForeground,
        current: terminalAPNs,
        lastForeground: nil
      ),
      "a delayed 10:00:05 reconciliation cannot overwrite a 10:00:01 terminal APNs event"
    )

    expect(
      CohubActivityEndPolicy.shouldRetainFinalState(
        snapshot: terminalSnapshot,
        currentSpaceId: "space-focus",
        currentOrigin: .local,
        currentSessionId: "session-1",
        currentTurnId: "turn-1"
      ),
      "matching terminal activity is retained briefly"
    )
    expect(
      !CohubActivityEndPolicy.shouldRetainFinalState(
        snapshot: snapshot,
        currentSpaceId: "space-focus",
        currentOrigin: .local,
        currentSessionId: "session-1",
        currentTurnId: "turn-1"
      ),
      "non-terminal activity is removed immediately"
    )
    expect(
      !CohubActivityEndPolicy.shouldRetainFinalState(
        snapshot: terminalSnapshot,
        currentSpaceId: "space-focus",
        currentOrigin: .local,
        currentSessionId: "session-1",
        currentTurnId: "different-turn"
      ),
      "mismatched terminal activity is removed immediately"
    )
    expect(
      !CohubActivityEndPolicy.shouldRetainFinalState(
        snapshot: terminalSnapshot,
        currentSpaceId: "space-focus",
        currentOrigin: .cloud,
        currentSessionId: "session-1",
        currentTurnId: "turn-1"
      ),
      "a terminal state from another origin is not retained"
    )
    expect(
      CohubNavigationPolicy.resolvedURL(for: nonDefaultPort) == nil,
      "non-default Cohub port cannot resolve for embedded navigation"
    )

    print("CohubNativeLogicTests: PASS")
  }
}
