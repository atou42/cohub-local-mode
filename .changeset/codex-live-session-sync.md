---
"@neta-art/cohub-cli": patch
---

Keep a Codex turn's original prompt and client identity stable when the user steers a running turn or answers a question, so native sync can complete the existing turn and continue importing later turns. Sync explicit local Codex session names to their bound Cohub sessions, including index-only renames and reconnects, without blocking message sync.

Restore in-progress file previews after reconnects and steering updates, and retry rejected or failed progress snapshots without requiring another local event.
