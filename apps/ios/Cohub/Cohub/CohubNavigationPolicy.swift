import Foundation

enum CohubOriginPolicy {
  static let host = "cohub.atou.cc"

  static func isTrusted(_ url: URL) -> Bool {
    guard hasTrustedSchemeAndHost(scheme: url.scheme, host: url.host) else { return false }
    return url.port == nil || url.port == 443
  }

  static func isTrustedSecurityOrigin(scheme: String?, host: String?, port: Int) -> Bool {
    hasTrustedSchemeAndHost(scheme: scheme, host: host) && (port == 0 || port == 443)
  }

  private static func hasTrustedSchemeAndHost(scheme: String?, host: String?) -> Bool {
    scheme?.lowercased() == "https" && host?.lowercased() == Self.host
  }
}

enum CohubNavigationPolicy {
  static let homeURL = URL(string: "https://cohub.atou.cc")!
  static let webHost = CohubOriginPolicy.host

  static func resolvedURL(for url: URL) -> URL? {
    switch url.scheme?.lowercased() {
    case "http", "https":
      return isCohubWebURL(url) ? url : nil
    case "cohub":
      return resolveCohubURL(url)
    default:
      return nil
    }
  }

  static func isCohubWebURL(_ url: URL) -> Bool {
    CohubOriginPolicy.isTrusted(url)
  }

  private static func resolveCohubURL(_ url: URL) -> URL? {
    guard let route = url.host?.lowercased() else { return nil }
    let routeComponents = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)

    switch route {
    case "spaces":
      guard isValidSpaceRoute(routeComponents) else { return nil }
    case "sessions":
      // Preserve the original one-segment Session route while new native surfaces
      // use the Space-scoped route required by the activity contract.
      guard routeComponents.count == 1, isIdentifier(routeComponents[0]) else { return nil }
    default:
      return nil
    }

    guard
      let queryItems = validatedQueryItems(
        for: route,
        routeComponents: routeComponents,
        url: url
      )
    else {
      return nil
    }

    var components = URLComponents(url: homeURL, resolvingAgainstBaseURL: false)
    components?.path = "/\(route)\(url.path)"
    components?.queryItems = queryItems
    components?.fragment = url.fragment
    return components?.url
  }

  private static func isValidSpaceRoute(_ components: [String]) -> Bool {
    if components.count == 1 {
      return isIdentifier(components[0])
    }
    if components.count == 3, components[1] == "sessions" {
      return isIdentifier(components[0]) && isIdentifier(components[2])
    }
    return false
  }

  private static func isIdentifier(_ value: String) -> Bool {
    (try? CohubIdentifier.validate(value)) != nil
  }

  private static func validatedQueryItems(
    for route: String,
    routeComponents: [String],
    url: URL
  ) -> [URLQueryItem]? {
    guard let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
      return nil
    }

    var origin: CohubSpaceOrigin?
    var turn: String?
    for item in queryItems {
      switch item.name {
      case "origin":
        guard origin == nil, let value = item.value, let decoded = CohubSpaceOrigin(rawValue: value)
        else { return nil }
        origin = decoded
      case "turn":
        guard
          route == "spaces",
          routeComponents.count == 3,
          turn == nil,
          let value = item.value,
          let sequence = Int(value),
          sequence >= 0,
          String(sequence) == value
        else { return nil }
        turn = value
      default:
        return nil
      }
    }

    guard let origin else { return nil }
    var normalized = [URLQueryItem(name: "origin", value: origin.rawValue)]
    if let turn {
      normalized.append(URLQueryItem(name: "turn", value: turn))
    }
    return normalized
  }
}
