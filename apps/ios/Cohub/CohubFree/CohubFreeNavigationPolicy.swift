import Foundation

enum CohubFreeNavigationPolicy {
  static let homeURL = URL(string: "https://cohub.atou.cc")!

  static func isTrusted(_ url: URL) -> Bool {
    guard hasTrustedSchemeAndHost(scheme: url.scheme, host: url.host) else { return false }
    return url.port == nil || url.port == 443
  }

  static func isTrustedSecurityOrigin(scheme: String?, host: String?, port: Int) -> Bool {
    hasTrustedSchemeAndHost(scheme: scheme, host: host) && (port == 0 || port == 443)
  }

  private static func hasTrustedSchemeAndHost(scheme: String?, host: String?) -> Bool {
    scheme?.lowercased() == "https" && host?.lowercased() == homeURL.host
  }
}
