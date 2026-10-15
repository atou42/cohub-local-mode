# Shared App Infrastructure

The shell, state and UI primitives behind four independent first-party Apps:

| App | Read scopes | Write scopes |
| --- | --- | --- |
| `task-inspector` | `taskrun.view` | None |
| `checkpoint-explorer` | `checkpoint.view` | `checkpoint.edit`; `file.view` to preview pending changes |
| `schedule-manager` | `cronjob.view`, `taskrun.view` for runs | `cronjob.manage`, `session.prompt.fullaccess` for creation |
| `app-manager` | `space.view` | `app.manage` |

Each App owns its entry, view and `dist/`. Opening without a resource shows a list in the invocation Space. Without a source Space, choose one using the authorization picker; Tasks also supports the current Session and My tasks. Each category uses one workspace Tab; resource IDs are launch state, not file paths. This package is private and is not published as an App.

## Layout

```text
src/
  mount.ts            entry: fonts, styles, Shell, view chunk preloaded in parallel
  shell/              Shell (routing, drafts, actions), list / detail / draft controllers
  ui/                 Button, StatusBadge, Notice, StateView, Skeleton, CodeBlock, dialogs …
  access.ts           scope checks and resource identity
  storage.ts          response cache and persistent drafts
  client.ts           SDK client, resource loading, related navigation
  styles.css          Tailwind with Web's semantic tokens mapped to host appearance
```

Views import helpers and shared views from Web's `apps/web/src/lib/resource-kit` through `$kit`, and Web's Paraglide catalog through `$messages`, so labels, status semantics, diff rendering and stats match the native pages exactly. Styling uses Web's Tailwind class names; `styles.css` maps them to the host `--cohub-*` appearance tokens with light / dark fallbacks.

## Development

```bash
pnpm --filter @cohub/protocol build
pnpm --filter @cohub/task-inspector dev
pnpm --filter "./cohub-apps/*" --if-present typecheck
```

Use each App's package name for `dev`, `build`, `typecheck` and `lint`. Scripts compile the Web Paraglide catalog from `apps/web/messages/`. Theme and locale follow the host. Set `VITE_COHUB_ENV=dev` for the development API; production is the default.

## Publish and enable

Build each App, then publish from `tzwm/cohub` with no publisher scopes:

```bash
cohub apps publish task-inspector --dir cohub-apps/task-inspector/dist --visibility public
cohub apps publish checkpoint-explorer --dir cohub-apps/checkpoint-explorer/dist --visibility public
cohub apps publish schedule-manager --dir cohub-apps/schedule-manager/dist --visibility public
cohub apps publish app-manager --dir cohub-apps/app-manager/dist --visibility public
```

Apps request viewer grants on the target Space; public App code does not grant access to resource data. Existing server permissions and ownership checks remain authoritative.

Web resolves the four Apps from `tzwm/cohub`; no environment configuration is required. Unavailable Apps fall back to the native page. Old resource URLs remain valid; `?native=1` opens the original page, which also offers actions the Apps do not yet have (Checkpoint and App **More actions**).

## State

- **Cache first.** Successful server responses are kept in session storage per viewer, App, Space and resource, render immediately on return and are revalidated silently. Oldest entries are evicted when storage fills. Permission failures clear the cached copy at once.
- **Live.** Task lists, running tasks and schedule runs follow Space realtime events; Save and App lists refresh on completion and publish events. Polling is only a fallback for running tasks and pauses while the window or tab is hidden.
- **Drafts.** Every edit is written to local storage; a failed write keeps the window dirty and blocks closing. Reopening a resource restores its draft with a notice and a Discard action. Structured prompts are never flattened.
- **Routes.** List and detail routes use the App hash, which the host preserves for refresh and history. Lists keep their rows, filter and scroll position when returning from a detail.

Validate real host/builder/guest permissions, grant revocation, cross-Space access, draft recovery and mobile navigation when publishing the Apps.
