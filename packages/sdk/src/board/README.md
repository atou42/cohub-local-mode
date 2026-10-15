# Board

How the Board code is organized, for people changing it. The document format
itself is described in [`docs/board.md`](../../../../docs/board.md); the public
API in the [SDK README](../../README.md#boards).

## Layers

Each directory is one layer and one subpath. A layer imports only the layers
below it; `tests/board/layers.test.ts` fails on anything else.

```
client   ──► replica, model                 (space.board(id), part of the root entry)
stage    ──► editor, player, render, model  (pixi.js, DOM)
export/node ──► export ──► render ──► model (pixi.js; export/node adds Node.js)
editor   ──► model                          (no framework, no pixi.js)
replica  ──► model
player   ──► model
model    ──► @cohub/protocol                (runs anywhere)
```

| Layer | Owns |
|---|---|
| `model` | Document helpers, geometry, scene, animation, item definitions and factories |
| `replica` | The local copy of a Board: pending writes, remote merge, retry |
| `editor` | Everything a user does to a Board, minus pixels |
| `player` | Playback frames and timing |
| `render` | One canvas renderer per item type |
| `stage` | The PixiJS scene, textures, input and DOM views for a live editor |
| `export` | Images of a document, given a renderer |
| `client` | HTTP and realtime transport; the only layer that knows about Spaces |

Cohub's own UI (toolbars, menus, i18n, generation, collaboration cursors) stays
in `apps/web` and talks to these layers through their public entries.

## The editor

`editor/editor.ts` assembles the editor from one module per concern, sharing an
`EditorContext` (`editor/context.ts`):

| Module | Concern |
|---|---|
| `document` | Base document → animation → local script effects → gesture draft → scene; commit, undo |
| `query` | Hit tests, bounds, spatial index, tree walks |
| `camera` | Viewport, zoom, focus, wheel |
| `selection` | Selection and edits applied to it |
| `creation` | New items, text editing |
| `deletion`, `copy` | Removing, duplicating, clipboard |
| `interaction` | The pointer state machine |
| `animation` | Playhead and keyframes |
| `snapshots` | Facts learned outside the document (file metadata, media sizes, task progress) |
| `remote` | Documents arriving from the server |

State lives in `state` fields grouped into channels (`STATE_CHANNELS`).
Assigning a field announces its channel; never mutate a value in place —
replace it, so views can compare by identity. Derived values use `memo` for the
same reason.

## Look

A renderer reads colors from `BoardRenderPalette` and everything else a theme
may change from `BoardRenderStyle` (`render/style.ts`): card silhouette, radius,
shadow, selection chrome, framed media, progress, icons, motion and chrome font.
Cards draw their body through `render/surface.ts`, so one silhouette and one
shadow serve every card type, and short facts above a card through
`render/card-tag.ts`. Selection and hover are not drawn by cards: the stage
overlay (`stage/overlay.ts`) owns them, so pointer and selection changes redraw
one layer. A renderer that still needs them sets `observesSelection`.

Cache keys include `context.themeKey` rather than individual palette fields.
Zoom-dependent detail flips on `boardCardDetailed`, which follows the text
resolution buckets; anything that must track every zoom step uses the
renderer's `zoom` hook and only touches transforms there.

## Scripts

The public authoring contract is in [`docs/board-scripts.md`](../../../../docs/board-scripts.md).
`model/script.ts` defines the module context; `model/script-scene.ts` validates scope
and composes local effects. `render/script-runtime.ts` is a self-contained kernel,
serialized into browser workers and Node VM workers so execution semantics do not
drift. Keep it free of imported runtime values and bundler-only helpers.

`render/script-modules.ts` resolves the ESM graph before code enters an isolated
realm. Browser hosting lives in `render/script-host.ts`; the stage
routes local input and adopts temporary output. Node export is a separate adapter
in `export/node/scripts.ts`. Script subscriptions, source loading, errors and
lifecycle belong to the host, not item renderers: culling a renderer must not reset
an instance. Static scripts schedule no idle animation frames. One opaque broker
iframe routes messages to per-instance workers and never executes user modules.
DOM `mount()` exports are rejected. The broker stamps routing tokens after worker data so scripts
cannot impersonate another instance. Output validation compiles only changed
instances; the stage composes them once per frame. Texture revisions invalidate
only their own card. Offscreen draws are omitted while simulation continues.

Boards without enabled scripts do not create a script host, message listener, DOM
layer, iframe or worker. The stage bypasses script clocks, composition and hit tests;
CLI exports reuse the native export preparation. `model/script-index.ts` shares a
single discovery scan per immutable item collection across editor, UI and hosts.
The module parser loads only when a script is actually read. Removing the last
enabled script destroys its host and clears local output without interrupting an
editor-owned pointer gesture.

Node export uses at most four persistent workers, with a separate module graph and
VM context per instance. Sequential samples advance the same state, while backwards
seeks recreate the affected instance. Clearing output textures does not reset the
simulation or reload modules.

Temporary items are absent from editor selection, clipboard subtrees and writes.
Explicit commits reuse the normal transaction and undo path. Future host capabilities
extend the context without adding business-specific fields to Board items.

## Adding an item type

1. Define it in `model/items/builtin.ts` with `defineBoardItem`: capabilities,
   and `hitTest`/`bounds` if the frame is too coarse. Extension types
   (`vendor.kind`) need no protocol change; built-in types also need a schema
   in `@cohub/protocol` (`board-model.ts`).
2. Give it a factory in `model/items/create.ts` if the default `registry.create`
   placement is not enough.
3. Draw it: a renderer in `render/renderers/`, listed in
   `board-renderer-registry.ts`, or a DOM view passed to the stage.
4. Cover it in `tests/board/`.

Never drop or rewrite fields of an item the client does not understand: write
patches with only what changed, and treat unknown types as plain boxes.
