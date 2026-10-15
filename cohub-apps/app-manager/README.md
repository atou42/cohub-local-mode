# App Manager

First-party Cohub App for App details, publishing, versions and management.

```bash
pnpm --filter @cohub/app-manager dev
pnpm --filter @cohub/app-manager typecheck
pnpm --filter @cohub/app-manager build
cohub apps publish app-manager --dir cohub-apps/app-manager/dist --visibility public
```

Publish with no publisher scopes. See [shared documentation](../shared/README.md) for authorization, verification and rollout.
