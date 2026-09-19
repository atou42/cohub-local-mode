import Combine
import SwiftUI
import UIKit
import WebKit

struct CohubFreeLoadFailure: Equatable, Identifiable {
  let id = UUID()
  let message: String

  static func == (lhs: CohubFreeLoadFailure, rhs: CohubFreeLoadFailure) -> Bool {
    lhs.message == rhs.message
  }
}

@MainActor
final class CohubFreeWebViewModel: ObservableObject {
  @Published private(set) var isLoading = true
  @Published private(set) var loadFailure: CohubFreeLoadFailure?

  private weak var webView: WKWebView?

  func attach(_ webView: WKWebView) {
    self.webView = webView
    guard webView.url == nil else { return }
    webView.load(
      URLRequest(url: CohubFreeNavigationPolicy.homeURL, cachePolicy: .useProtocolCachePolicy)
    )
  }

  func retry() {
    loadFailure = nil
    if webView?.url != nil {
      webView?.reload()
    } else {
      webView?.load(
        URLRequest(url: CohubFreeNavigationPolicy.homeURL, cachePolicy: .useProtocolCachePolicy)
      )
    }
  }

  fileprivate func navigationStarted() {
    isLoading = true
    loadFailure = nil
  }

  fileprivate func navigationFinished() {
    isLoading = false
    loadFailure = nil
  }

  fileprivate func navigationFailed(_ error: Error) {
    let nsError = error as NSError
    guard nsError.code != NSURLErrorCancelled else { return }
    isLoading = false
    loadFailure = CohubFreeLoadFailure(message: error.localizedDescription)
  }
}

struct CohubFreeWebView: UIViewRepresentable {
  @ObservedObject var model: CohubFreeWebViewModel

  func makeCoordinator() -> Coordinator {
    Coordinator(model: model)
  }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.allowsInlineMediaPlayback = true
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.applicationNameForUserAgent = "CohubFree/0.1"

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.uiDelegate = context.coordinator
    webView.allowsBackForwardNavigationGestures = false
    webView.scrollView.contentInsetAdjustmentBehavior = .automatic
    webView.scrollView.keyboardDismissMode = .interactive
    webView.scrollView.bounces = false
    webView.scrollView.alwaysBounceVertical = false
    webView.scrollView.alwaysBounceHorizontal = false
    webView.scrollView.isDirectionalLockEnabled = true
    webView.scrollView.showsHorizontalScrollIndicator = false
    #if DEBUG
      webView.isInspectable = true
    #endif
    model.attach(webView)
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    model.attach(webView)
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let model: CohubFreeWebViewModel

    init(model: CohubFreeWebViewModel) {
      self.model = model
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
      model.navigationStarted()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
      model.navigationFinished()
    }

    func webView(
      _ webView: WKWebView,
      didFailProvisionalNavigation navigation: WKNavigation?,
      withError error: Error
    ) {
      model.navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
      model.navigationFailed(error)
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      guard let url = navigationAction.request.url else {
        decisionHandler(.cancel)
        return
      }

      guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
        return
      }

      if navigationAction.targetFrame == nil {
        if CohubFreeNavigationPolicy.isTrusted(url) {
          webView.load(navigationAction.request)
        } else {
          UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
        return
      }

      if navigationAction.targetFrame?.isMainFrame == true,
        !CohubFreeNavigationPolicy.isTrusted(url)
      {
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
        return
      }

      decisionHandler(.allow)
    }

    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      guard let url = navigationAction.request.url else { return nil }
      if CohubFreeNavigationPolicy.isTrusted(url) {
        webView.load(navigationAction.request)
      } else {
        UIApplication.shared.open(url)
      }
      return nil
    }

    func webView(
      _ webView: WKWebView,
      requestMediaCapturePermissionFor origin: WKSecurityOrigin,
      initiatedByFrame frame: WKFrameInfo,
      type: WKMediaCaptureType,
      decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
      decisionHandler(
        frame.isMainFrame && CohubFreeNavigationPolicy.isTrustedSecurityOrigin(
          scheme: origin.protocol,
          host: origin.host,
          port: origin.port
        )
          ? .grant : .deny
      )
    }
  }
}
