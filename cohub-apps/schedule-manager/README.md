# Schedule Manager

First-party Cohub App for scheduled prompt creation, editing and run history.

```bash
pnpm --filter @cohub/schedule-manager dev
pnpm --filter @cohub/schedule-manager typecheck
pnpm --filter @cohub/schedule-manager build
cohub apps publish schedule-manager --dir cohub-apps/schedule-manager/dist --visibility public
```

Publish with no publisher scopes. See [shared documentation](../shared/README.md) for authorization, verification and rollout.
