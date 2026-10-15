# Checkpoint Explorer

First-party Cohub App for snapshot details, diffs and read-only files.

```bash
pnpm --filter @cohub/checkpoint-explorer dev
pnpm --filter @cohub/checkpoint-explorer typecheck
pnpm --filter @cohub/checkpoint-explorer build
cohub apps publish checkpoint-explorer --dir cohub-apps/checkpoint-explorer/dist --visibility public
```

Publish with no publisher scopes. See [shared documentation](../shared/README.md) for authorization, verification and rollout.
