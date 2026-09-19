import SwiftUI
import WidgetKit

@main
struct CohubWidgetsBundle: WidgetBundle {
  var body: some Widget {
    CohubFocusBoardWidget()
    CohubAgentPulseLiveActivity()
  }
}
