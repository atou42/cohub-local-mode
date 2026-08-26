# Upstream Sync Ledger

## Goal

Publish the verified rebased Local Mode history to the private remote with a recoverable pre-push reference, then run a daily upstream assessment on the Mac mini and deliver every conclusion to Discord thread `1540358055563100230`.

## Boundaries

- The watcher observes, assesses, records, and notifies only.
- It never rebases, resolves conflicts, changes application state, or pushes future upstream changes.
- A failed fetch or malformed state cannot reuse an old success verdict.
- A failed Discord delivery cannot advance successful-delivery state.
- Runtime reports and delivery state live outside the repository in `~/.cohub-upstream-watch`.

## Remote Baseline

- Local publish candidate before watcher work: `68281840ebdbb5584916f369fc1fce2a00a415a2`.
- Upstream baseline: `8f91566aa92bf5fae5cea4cac2557b1c2e8cd947`.
- Previous remote `main`: `eec559e6550679fcb9e13d92449544c78a71ac38`.
- Remote recovery branch: `backup/pre-rebase-main-20260826` at the previous remote `main`.
- The final `main` update must use an explicit lease for the previous remote hash.

## Current Status

The remote recovery branch exists. The watcher is installed in launchd for 10:00 Asia/Shanghai and has completed real success and failure notifications. Remote `main` has not yet been rewritten.

## Evidence, Decisions, And Failures

- The fixed notification destination is Discord thread `1540358055563100230` using the existing Codex bot sender in `/Users/atou/agents-in-discord`.
- The schedule is 10:00 in the Mac mini system timezone, which is Asia/Shanghai.
- Each run writes its complete report before delivery. Successful state is written only after Discord confirms the expected channel and message ID.
- Daily Discord nonces are deterministic per result identity so an accidental repeated run does not create duplicate messages.
- Immediate rebase assessment is reserved for direct file overlap, security-sensitive commits, or fixes in Agent, relay, session, migration, protocol, and Local Mode paths. Broader critical changes receive a near-term review verdict instead of being mislabeled as urgent.
- Seven focused classifier, rendering, parsing, nonce, and corrupt-state tests pass. Biome checks the four watcher source and test files cleanly.
- A simulated missing upstream remote produced a non-zero exit, refused to reuse an old verdict, and delivered failure notice `1542035675912601692` to the fixed thread.
- A real upstream fetch and assessment delivered success notice `1542035795114987550` to the fixed thread with verdict `observe` because local already contains upstream `8f91566a`.
- Repeating the same successful check returned the same Discord message ID. The watcher now short-circuits later same-day runs when both local and upstream heads are unchanged, keeping the stored report identical to the delivered message.
- A simulated missing Discord sender left the complete report plus a delivery-error record and did not create `state.json` in its isolated state directory.
- A malformed state file produced a non-zero exit and an explicit failure report without overwriting the corrupt file.
- A dry-run force push with an intentionally wrong lease was rejected by the real remote as `stale info`, proving an unexpected remote `main` change blocks publication.
- The installed plist contains only paths and non-secret settings. It targets thread `1540358055563100230`, runs daily at 10:00, and writes logs under `~/.cohub-upstream-watch/logs`.
