import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  }
}

@main
struct CohubFreeLogicTests {
  static func main() {
    expect(
      CohubFreeNavigationPolicy.isTrusted(URL(string: "https://cohub.atou.cc")!),
      "the exact production origin is trusted"
    )
    expect(
      CohubFreeNavigationPolicy.isTrusted(URL(string: "https://cohub.atou.cc:443/spaces/one")!),
      "explicit HTTPS port 443 is trusted"
    )
    expect(
      !CohubFreeNavigationPolicy.isTrusted(URL(string: "http://cohub.atou.cc")!),
      "insecure HTTP is rejected"
    )
    expect(
      !CohubFreeNavigationPolicy.isTrusted(URL(string: "https://cohub.atou.cc:8443")!),
      "a non-default port is rejected"
    )
    expect(
      !CohubFreeNavigationPolicy.isTrusted(URL(string: "https://sub.cohub.atou.cc")!),
      "a subdomain is rejected"
    )
    expect(
      !CohubFreeNavigationPolicy.isTrusted(URL(string: "https://cohub.atou.cc.example.com")!),
      "a suffix-confusion host is rejected"
    )
    expect(
      CohubFreeNavigationPolicy.isTrustedSecurityOrigin(
        scheme: "https",
        host: "cohub.atou.cc",
        port: 0
      ),
      "WebKit's default HTTPS security-origin port is trusted"
    )
    expect(
      !CohubFreeNavigationPolicy.isTrustedSecurityOrigin(
        scheme: "https",
        host: "cohub.atou.cc.example.com",
        port: 443
      ),
      "a suffix-confusion security origin is rejected"
    )

    print("CohubFree logic checks passed")
  }
}
