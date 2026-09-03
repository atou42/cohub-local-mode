# macOS Connector Alpha Goal Ledger

## Goal

Replace the window-bound Personal Node application with a dependable macOS Connector. The Connector runs from the menu bar, keeps the local Cohub node available while the browser is closed, and lets the same signed-in user operate local Spaces through `https://dev-cohub.atou.cc` from desktop or mobile browsers.

The Connector must preserve the existing Cloudflare relay, local Space data, local Agent sessions, Codex, Pi, Grok Build, Cursor Agent, files, generation, models, effort controls, Slash commands, and session behavior. Production `cohub.atou.cc` must remain untouched.

## Scope

The macOS application becomes a background menu-bar process rather than an embedded browser. It owns the bundled local runtime and Cloudflare relay, starts at login, reports its real state to the development control plane, recovers from local service crashes, keeps durable diagnostics, and stops all owned services on an explicit quit.

The Web application reads the Connector state from Cloudflare and explains initialization, reconnect, recovery, terminal failure, explicit stop, and offline states without pretending an unhealthy node is online.

This goal does not change local data schemas, redesign Cohub, add Windows or Linux support, replace Cloudflare, alter production resources, or add an updater.

## Acceptance

On a clean ARM64 Mac, installation and sign-in require no terminal work. The Connector appears in the menu bar and offers Open Cohub, Sign In when required, Reconnect, View Diagnostics, Start at Login, and Quit. Closing the browser does not stop the node. Quit stops every owned child service and the browser reports the node as stopped or offline.

The menu and browser must distinguish signed out, starting, connected, recovering, failed, and stopped states. Recovery reports the current bounded attempt and the underlying error. Full diagnostics remain on the Mac. Cloud status messages are bounded and stripped of credential-shaped values.

A local runtime crash must trigger whole-stack recovery without losing the Connector process. Recovery is limited to five attempts with increasing delays. An unowned process occupying a Cohub port must never be killed. Damaged state must fail explicitly rather than being reset or presented as a normal empty state.

The deployed development site must remain reachable on desktop and mobile. The new node-status endpoint must require a valid device credential. The release configuration must continue to prove that no production Worker, route, namespace, Queue, bucket, or domain is targeted.

The goal is complete only after the packaged build passes automated checks, a real packaged runtime crash and recovery test, a real quit and orphan-process check, live development-site checks, visual delivery checks, and installation acceptance on a second non-development Mac.

## Failure Conditions

The release fails if browser closure stops the node, the menu reports connected before both relay and local runtime are ready, recovery loops without a bound, an owned service survives Quit, an unrelated process can be terminated, corrupt status becomes offline, a node can report status without device authentication, the development deployment touches production, or the second Mac cannot install and remain online.

## Implementation Record

The Electron renderer and preload bridge were removed. The application now runs as an `LSUIElement` menu-bar Connector and preserves the existing application identity and user-data directory for upgrades. It starts the Cloudflare relay independently of the heavier local stack, supervises the runtime as an owned process group, persists rotated diagnostics, restores stale owned processes, and performs bounded whole-stack recovery.

The Relay accepts authenticated Connector status reports and stores the server-timestamped state with the node. The Web application polls that state for Personal Node sessions and displays current progress or failure details. Corrupt status payloads and non-successful status reads are surfaced as errors.

## Verification Record

Desktop recovery and state tests pass four cases. Relay status tests pass seventeen cases. Web status tests pass four cases. Desktop, Relay, and Web type checks pass; Web reports zero errors and zero warnings. Source whitespace checks pass, and the tracked local-mode Worker wrapper remains unchanged by the Alpha build.

The isolated packaged runtime reached healthy state from a clean profile. Its first extraction and first database initialization took approximately six minutes; the final packaged artifact later reached health with the installed runtime in 53 seconds. PostgreSQL was then terminated with `SIGKILL`. The Connector reported recovery attempt 1 of 5 with the exact failure, created a new PostgreSQL process, and restored API health in 55 seconds.

A real macOS Quit event stopped the application and every process and listener owned by the test profile. The runtime owner marker was removed. A transient privileged sandbox descendant no longer leaves a false shutdown error or stale ownership marker.

The release image is `Cohub-Connector-0.2.0-alpha.1-arm64.dmg`, 261 MB, with SHA-256 `a057da86e37daac1f7049a7e8dfdafe31f546bc0961959fda0214560ed3b9810`. The DMG checksum and strict deep application signature verification pass. The packaged application contains the verified runtime archive and manifest, and `LSUIElement` is enabled.

The live development health endpoint returns 200 and ready. The Connector status endpoint rejects a request without authentication with 401. Production `cohub.atou.cc` still resolves through its unchanged Cloudflare Access route. The deployed Relay version is `ec2a6f72-2424-4d2c-bc5d-48a0a740e5f5`; the deployed Web version is `37761726-9dec-4e5a-bc0b-ce67e8883d2b`.

The authenticated development Space was inspected at 1440 by 900 and 390 by 844 through the shared browser. Both views render the application and explicit offline state without a blank page, horizontal overflow, missing controls, or layout overlap. The mechanical visual-gate script could not load because Playwright is not installed in the repository, so its browser check was replaced by equivalent Chrome debugging screenshots and DOM viewport measurements.

## Remaining Acceptance

The packaged Connector still needs installation acceptance on the user's second MacBook. That run must confirm the visible menu-bar states, browser independence, sign-in and reconnect behavior, and explicit Quit from the menu. Until that evidence exists, this goal remains active rather than being marked complete.
