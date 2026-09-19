# Cohub for iOS

This project is a native SwiftUI host for the existing Cohub Web application. It keeps WebKit's persistent website data store so Cloudflare Access and Cohub sessions survive normal app restarts.

The `CohubWidgets` extension provides the small and medium Focus Board widgets plus the Agent Pulse Live Activity. Both surfaces read one validated snapshot from the `group.cc.atou.cohub.shared` App Group. The Web host can replace that snapshot only through the main-frame, same-origin `cohubActivity` bridge.

Open `Cohub.xcodeproj`, select the shared `Cohub` scheme, choose an Apple development team with App Groups and push notifications enabled, then run on a paired iPhone. The app uses `https://cohub.atou.cc` as its home and maps Space and Session deep links back into that host.

## Install with a free Personal Team

The shared `CohubFree` scheme is an app-only preview for a free Apple account. It deliberately has no Widget extension, App Group, push entitlement, ActivityKit bridge, or background Agent Pulse. The full `Cohub` target remains unchanged.

On the MacBook, open `Cohub.xcodeproj`, sign in under Xcode > Settings > Apple Accounts, select the `CohubFree` scheme, and choose the Personal Team in the `CohubFree` target's Signing & Capabilities pane. Connect the iPhone, trust the Mac, enable Developer Mode when prompted, select the iPhone as the run destination, and press Run. If Apple's portal reports that `cc.atou42.cohub.preview` is unavailable, replace it with another identifier unique to that Apple account.

Free provisioning expires after seven days. Reopen the project and Run again to reinstall. Use the full `Cohub` scheme only after the developer team supports App Groups and push notifications.

Run the native logic checks with:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -parse-as-library Shared/CohubActivityState.swift Shared/CohubActivityStore.swift Cohub/CohubNavigationPolicy.swift Tests/main.swift -o /tmp/cohub-native-tests
/tmp/cohub-native-tests
```

Simulator builds do not require a signing identity:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project Cohub.xcodeproj -scheme Cohub -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The free preview has its own logic check and build:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -parse-as-library CohubFree/CohubFreeNavigationPolicy.swift Tests/FreePreview/main.swift -o /tmp/cohub-free-tests
/tmp/cohub-free-tests
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project Cohub.xcodeproj -scheme CohubFree -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
