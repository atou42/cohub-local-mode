# Add WorkBuddy history sync and continuation to Cohub Local

Cohub Local can now discover WorkBuddy, display/import project conversations, and continue them from Cohub using WorkBuddy's bundled CLI and model catalog. The protocol, server validation, SDK, CLI and web selector/status display recognize WorkBuddy consistently.

Each Cohub turn uses a private native history copy while retaining the same cloud conversation. Original desktop histories remain unchanged. Desktop-owned or unsynchronized source histories block continuation; verified prefix markers prevent restored history from being ingested twice. Malformed records, missing attachments, unsupported controls, execution failures and uncertain crash outcomes remain explicit.

## Validation

- 54 CLI WorkBuddy/lifecycle tests and 33 existing native history/archive/projection tests pass.
- 16 existing execution/recovery/batch tests and all 10 native-ingestion tests pass with the canonical macOS temporary path (`TMPDIR=/private/tmp`).
- Protocol 189, SDK runtime 2, core prompt model 3, queue 4 and web model/status 14 tests pass.
- CLI build; CLI/protocol/SDK/infrastructure/web typechecks; changed-file lint pass.
- Real WorkBuddy 5.1.3 / CLI 2.103.3 initializes and replays synthetic text/image/reasoning/tool history without changing the source. No model prompt was sent.
- Full server checks remain blocked by missing local dependencies/build exports. Browser visual verification was blocked by tool connection-policy errors. Environment details are recorded in `docs/workbuddy-local-validation.md`.

## Acceptance boundaries

Keep as a draft until live account execution, continuation, cancellation and sync are accepted. No deployment, paid model use or user-history upload has occurred. Desktop and Cohub do not jointly control an open WorkBuddy conversation. Only macOS automatic discovery has been validated.
