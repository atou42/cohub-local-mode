import SwiftUI

@main
struct CohubApp: App {
  @StateObject private var webViewModel = CohubWebViewModel()

  var body: some Scene {
    WindowGroup {
      ContentView(model: webViewModel)
        .onOpenURL { url in
          webViewModel.open(url)
        }
    }
  }
}
