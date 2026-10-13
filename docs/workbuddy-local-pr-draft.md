# Add WorkBuddy history sync and continuation to Cohub Local

Cohub Local discovers the installed WorkBuddy application, imports project conversations, and lets users choose WorkBuddy and its native models to continue from Cohub. Protocol, server validation, SDK, CLI and desktop/mobile web controls recognize it consistently.

Each Cohub turn runs in a private native history copy while retaining the same cloud conversation. Original desktop histories remain unchanged. Busy or unsynchronized sources block continuation; replayed prefixes are not imported twice. Text and parallel tool events sharing a native ID are preserved. Corrupt records, unfinished history, unsupported controls and uncertain cleanup remain explicit errors.

Adding WorkBuddy to existing Pi/Codex sync asks only about newly added history, and honors WorkBuddy's explicit direct-connection setting without changing the Runtime's own network settings.

## Validation

- 65 focused CLI regressions, including the new fixes reproduced before implementation.
- Real WorkBuddy 5.3.14 / CLI 2.115.0: native history import, streamed reply, remembered-context continuation, cancellation with preserved partial text, source integrity and no duplicate import all passed with synthetic prompts.
- Desktop and mobile component previews: WorkBuddy selection and model picker verified.
- Protocol 189, SDK runtime 2, core model 3, queue 4 and web model/status 14 tests passed; CLI build and applicable typechecks/lint passed on the implementation base.
- Full server checks require private dependencies unavailable locally. See `docs/workbuddy-local-validation.md` for evidence and boundaries.

No production history upload or deployment occurred. Real-Space and cross-device acceptance remains pending deployment. Desktop and Cohub do not jointly control an open WorkBuddy conversation.
