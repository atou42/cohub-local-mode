import SwiftUI

struct CohubFreeContentView: View {
  @ObservedObject var model: CohubFreeWebViewModel

  var body: some View {
    ZStack(alignment: .top) {
      CohubFreeWebView(model: model)

      if model.isLoading {
        ProgressView()
          .progressViewStyle(.linear)
          .tint(Color(red: 1, green: 0.24, blue: 0))
          .accessibilityLabel("Loading Cohub")
      }

      if let failure = model.loadFailure {
        VStack(spacing: 16) {
          Image(systemName: "wifi.exclamationmark")
            .font(.system(size: 30, weight: .medium))
            .foregroundStyle(.secondary)

          VStack(spacing: 6) {
            Text("Cohub could not load")
              .font(.headline)
            Text(failure.message)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }

          Button("Try Again") {
            model.retry()
          }
          .buttonStyle(.borderedProminent)
          .tint(Color(red: 1, green: 0.24, blue: 0))
        }
        .padding(24)
        .frame(maxWidth: 320)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground).opacity(0.94))
      }
    }
    .background(Color(uiColor: .systemBackground))
  }
}
