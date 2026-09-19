import Combine
import SwiftUI
import UIKit
import WebKit

struct CohubLoadFailure: Equatable, Identifiable {
  let id = UUID()
  let message: String

  static func == (lhs: CohubLoadFailure, rhs: CohubLoadFailure) -> Bool {
    lhs.message == rhs.message
  }
}

@MainActor
final class CohubWebViewModel: ObservableObject {
  @Published private(set) var isLoading = true
  @Published private(set) var loadFailure: CohubLoadFailure?

  private weak var webView: WKWebView?
  private var pendingURL: URL?
  private let activityController: CohubActivityController
  private let activityBridge: CohubActivityBridge

  init() {
    let controller = CohubActivityController()
    self.activityController = controller
    self.activityBridge = CohubActivityBridge(controller: controller)
    controller.setEventHandler { [weak self] detail in
      self?.emitNativeEvent(detail)
    }
  }

  func attach(_ webView: WKWebView) {
    self.webView = webView
    guard webView.url == nil else { return }
    load(pendingURL ?? CohubNavigationPolicy.homeURL)
    pendingURL = nil
  }

  func open(_ url: URL) {
    guard let destination = CohubNavigationPolicy.resolvedURL(for: url) else { return }
    guard let webView else {
      pendingURL = destination
      return
    }
    webView.load(URLRequest(url: destination, cachePolicy: .useProtocolCachePolicy))
  }

  func retry() {
    loadFailure = nil
    if webView?.url != nil {
      webView?.reload()
    } else {
      load(CohubNavigationPolicy.homeURL)
    }
  }

  fileprivate func navigationStarted() {
    isLoading = true
    loadFailure = nil
  }

  fileprivate func navigationFinished() {
    isLoading = false
    loadFailure = nil
    emitNativeEvent(["schemaVersion": 1, "type": "bridge.ready"])
  }

  fileprivate func receiveActivityMessage(_ message: WKScriptMessage) {
    Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        try await activityBridge.receive(message)
      } catch CohubActivityStoreError.duplicateOrOutOfOrder {
        return
      } catch {
        let failedAction = ((message.body as? [String: Any])?["type"] as? String)
          .flatMap(CohubBridgeMessageType.init(rawValue:))?.rawValue ?? "bridge.message"
        emitNativeEvent([
          "schemaVersion": 1,
          "type": "action.failed",
          "action": failedAction,
          "reason": String(describing: error),
        ])
      }
    }
  }

  fileprivate func navigationFailed(_ error: Error) {
    let nsError = error as NSError
    guard nsError.code != NSURLErrorCancelled else { return }
    isLoading = false
    loadFailure = CohubLoadFailure(message: error.localizedDescription)
  }

  private func load(_ url: URL) {
    webView?.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy))
  }

  private func emitNativeEvent(_ detail: [String: Any]) {
    guard
      let webView,
      let currentURL = webView.url,
      CohubNavigationPolicy.isCohubWebURL(currentURL),
      JSONSerialization.isValidJSONObject(detail),
      let data = try? JSONSerialization.data(withJSONObject: detail),
      let json = String(data: data, encoding: .utf8)
    else { return }

    let source = "window.dispatchEvent(new CustomEvent('cohub:native',{detail:\(json)}));"
    webView.evaluateJavaScript(source)
  }
}

struct CohubWebView: UIViewRepresentable {
  @ObservedObject var model: CohubWebViewModel

  func makeCoordinator() -> Coordinator {
    Coordinator(model: model)
  }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.allowsInlineMediaPlayback = true
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.applicationNameForUserAgent = "CohubNative/0.1"

    let markerScript = WKUserScript(
      source: "window.__COHUB_NATIVE__ = Object.freeze({ platform: 'ios', version: '0.1' });",
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    )
    configuration.userContentController.addUserScript(markerScript)
    configuration.userContentController.add(context.coordinator, name: "cohubActivity")

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.uiDelegate = context.coordinator
    webView.allowsBackForwardNavigationGestures = false
    // Standard sign-in pages rely on UIKit's safe-area inset, while Cohub's
    // viewport-fit=cover page handles its own CSS safe areas.
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

  static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "cohubActivity")
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let model: CohubWebViewModel

    init(model: CohubWebViewModel) {
      self.model = model
    }

    func userContentController(
      _ userContentController: WKUserContentController,
      didReceive message: WKScriptMessage
    ) {
      guard message.name == "cohubActivity" else { return }
      model.receiveActivityMessage(message)
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

      if url.scheme?.lowercased() == "cohub" {
        if let destination = CohubNavigationPolicy.resolvedURL(for: url) {
          webView.load(URLRequest(url: destination))
        }
        decisionHandler(.cancel)
        return
      }

      guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
        return
      }

      if navigationAction.targetFrame == nil {
        if CohubNavigationPolicy.isCohubWebURL(url) {
          webView.load(navigationAction.request)
        } else {
          UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
        return
      }

      if navigationAction.targetFrame?.isMainFrame == true,
        !CohubOriginPolicy.isTrusted(url)
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
      if CohubNavigationPolicy.isCohubWebURL(url) {
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
      let isTrustedMainFrame = frame.isMainFrame
        && CohubOriginPolicy.isTrustedSecurityOrigin(
          scheme: origin.protocol,
          host: origin.host,
          port: origin.port
        )
      decisionHandler(isTrustedMainFrame ? .grant : .deny)
    }
  }
}
