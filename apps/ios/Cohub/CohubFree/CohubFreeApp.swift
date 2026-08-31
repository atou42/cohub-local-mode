import SwiftUI

@main
struct CohubFreeApp: App {
  @StateObject private var webViewModel = CohubFreeWebViewModel()

  var body: some Scene {
    WindowGroup {
      CohubFreeContentView(model: webViewModel)
    }
  }
}
