---
name: cohub-board
description: Create, edit, animate, play back, and export Cohub Boards — a free-form JSON document of items, settings, and animations. Use for any Board authoring task.
---

# Cohub Boards

A Board is one JSON document: `board` settings, an `items` map, and an
`animations` map. Authoring is writing that JSON — `apply` merges a patch of the
same shape into the document and lands it as one version. Anything the desktop
editor can express, a patch can express.

```json
{"board":{"background":{"kind":"grid"}},
 "items":{
   "title":{"type":"text","position":{"x":80,"y":60},"props":{"text":"Plan","fontSize":48}},
   "hero":{"type":"shape","position":{"x":80,"y":160},"size":{"width":240,"height":120},"props":{"geometry":"rounded","text":"Ship"}}},
 "animations":{
   "intro":{"duration":1200,"tracks":{
     "title-in":{"target":"title","property":"opacity","keyframes":[{"at":0,"value":0},{"at":600,"value":1}]}}}}}
```

`items` and `animations` are objects keyed by id, not arrays — you name every item
you write. A patch has the same shape as the document, so `apply` only touches the
ids it mentions.

Use the Cohub CLI; it targets the current Space by default (`-s <spaceId>` only for
another Space). Add `--json` when chaining commands. Requires CLI 9.1.0+ — if Board
subcommands are missing, run `npm install -g @neta-art/cohub-cli`.

## Read, write, verify

Every command takes a Board ID or a `.board` path. Read with `get`, write with
`apply` — fields merge, arrays replace, `null` deletes, anything unmentioned stays.

```bash
cohub boards get <board> --only board          # settings only
cohub boards get <board> --within s1           # frame s1 and its children
cohub boards get <board> --rect 0,0,1600,900   # a region

cohub boards apply <board> '{"items":{"title":{"props":{"text":"New title"}}}}'
cohub boards apply <board> -i patch.json --dry-run   # validate, then drop --dry-run
cohub boards apply <board> -i -                      # patch from stdin
```

- Group a whole change into one patch so it lands as one version. Update only the
  affected content. Use `--base-version` when rewriting a timeline or replacing the
  document to avoid overwriting concurrent edits.
- `--replace` makes the document equal to the patch instead of merging.
- `--cascade` also deletes children and the tracks targeting a deleted item;
  arrows bound to a deleted item keep their place and fall back to a point.
- Deleting a still-referenced item fails and lists the references.
- `--base-version <n>` fails on conflict instead of merging; `--mutation-id` makes
  a retry idempotent. Without `--base-version` a conflict is rebased once and retried.

`schema` answers field questions without guessing — it is the source of truth:

```bash
cohub boards schema              # units, item types, colors, every animatable property
cohub boards schema shape        # one item type; also arrow, text, effect, frame, …
cohub boards schema track        # a track: target, property, keyframes, composite, interpolation
```

## Items

An item is placed by `position` / `size`, colored by `style`, and described by
`props`:

```json
{"id":"hero","type":"shape","position":{"x":120,"y":160},"size":{"width":280,"height":140},
 "props":{"geometry":"rounded","text":"Ship"},"style":{"fill":"green","fillOpacity":0.12}}
```

- `type`: `frame | text | shape | draw | arrow | image | video | audio | file | task | effect | custom`
- Only `frame` items can be parents; `position` is relative to `parent`.
- Colors are theme-aware palette tokens (`cohub boards schema` lists them), any CSS
  color, or `{ "light": …, "dark": … }`. Prefer tokens; they stay legible in both themes.

Geometry follows the item type; `draw` and `arrow` derive their size from their points:

| Item | Geometry |
|---|---|
| `shape` `frame` `image` `video` `audio` `file` `task` `effect` | `position` + `size`; per-type defaults — omit what you don't mean to set |
| `text` | `position` only; `props.width` wraps, height follows the text |
| `draw` | `points` use item-local coordinates and move with the item and its parent frame |
| `arrow` | Unbound `start` / `end` use item-local coordinates; bound endpoints follow their target |

Shape paths fit the item's size. Put items that move together inside a frame with
`props.decoration: "none"`. Set `clip: false` to let contents extend outside it.

Media items (`image`, `video`, `audio`, `file`) reference a Space file by `src`, a
path relative to the workspace root (`/workspace/media/a.png` → `media/a.png`). A
`src` that is missing or not a relative Space path keeps the item as `legacy.<type>`
instead of rendering it. Images fit inside `size`; to fill a box of another aspect
ratio, set `props.crop` (`{x, y, w, h}`, fractions of the image) to the region to show.

## Scripts

Any item can attach `script: { src: "scripts/example.js", params: {}, targets: {} }`.
Author and edit modules through files and CLI patches; the Web UI only indicates
scripted content and provides interact/pause/reset controls. To start:

```sh
mkdir -p scripts
cohub boards examples custom --module > scripts/wave.js
cohub boards examples custom > custom.json
cohub boards create demo.board -i custom.json
```

Use `boards apply` to attach scripts or adjust `script.params`; use `null` to remove
an obsolete parameter. Coordinate many elements from a Frame script to keep the
number of isolated runtimes small.
Create a `custom` item for module-supplied content. `sketch` has been replaced by
`custom`; module configuration is always in `script`, never in `props`.

Modules may export synchronous `draw(ctx, frame)` or default setup `function(ctx)`.
They run in workers with no DOM; `mount()` is unsupported. `ctx.on`, `ctx.onFrame`, `ctx.self.present`,
`ctx.scene` and `ctx.hitRegions` provide input and temporary output. Native menus
are not a platform feature: compose controls in the module. Frame scripts can
coordinate descendants; `script.targets` adds explicit references. Temporary output
is local and never enters history. Only `await ctx.commit(patch)` persists a change.

Use literal relative module imports. For reproducible motion, use the host clock
and `ctx.random()`. Use Apps for HTML/JavaScript content. Export
samples fresh state at the requested time and does not replay live clicks.

## Board settings

`board` sits alongside `items` — background, grid, and the entry motion. The rest
of the fields and their values are in `cohub boards schema board`:

```json
{"board":{"background":{"kind":"grid"},"grid":{"visible":true,"size":24},
          "enter":{"preset":"deal","duration":600}}}
```

`background.kind` is `solid`, `dots`, `grid`, or `image`.

## Animation

An animation is one timeline in the `animations` map: an optional `duration`
plus `tracks`, each driving one property of one target by JSON path (`position`,
`opacity`, `style.fill`, `props.text`, …). The header fields are `duration`,
`play` (`manual`, `auto`, `always`), `end` (`hold` or `reset`), `delay`, `loop`
and `markers` — the full shapes are in `cohub boards schema animation`.

Tracks are just JSON, so write them directly; `preset` only saves keystrokes. With
`--animation` it prints an apply-ready patch; without it, bare `tracks` to fold into
an animation of your own.

```bash
cohub boards preset rise --targets a,b,c --animation intro --stagger 120ms | cohub boards apply <board> -i -
cohub boards preset float --targets ship > idle-tracks.json   # bare tracks, no animation wrapper
```

Presets are named in `cohub boards preset -h`. A camera is just another target and
drives `focus`, `zoom`, `center` or `shake`.

Start each chapter at time 0. Use `boards sequence` to generate a combined patch,
then write it with `apply`. Regenerate after changing chapter durations or order.
Use `boards path` to generate motion keyframes; use scripts for complex drawings.

## Create

A file is created at the path you pass; the document is optional. The `.board` file
only points to the Board — never write it by hand; pass the initial document to
`create` with `-i`. Examples are valid patches, so the same file works with `boards apply`.

```bash
cohub boards examples                        # basic, workflow, slides, lesson, custom
cohub boards examples workflow > seed.json
cohub boards create boards/plan.board --title "Plan" -i seed.json
```

## Present and share

Build and check one scene, then open the Board and add the remaining scenes in
coherent patches. Preview locally while checking; use shared playback to present:

```bash
cohub desktop open file://boards/plan.board
cohub boards apply <board> -i beat.json
```

Playback moves every viewer together; a marker with `pause: true` holds until `next`:

```bash
cohub boards play <board> <animation> --at 2.5s
cohub boards pause <board>
cohub boards resume <board>
cohub boards stop <board>
cohub boards seek <board> 12.5s
cohub boards watch <board>    # stream changes and playback while you work
```

## Export

Users view the Board file itself; render an image only to self-check your edits or
to share a snapshot. `-o` picks the format; a `--at` range with `%d` writes a frame
sequence, and a video extension writes a video (`--help` lists the rest).

```bash
cohub boards export <board> -o /tmp/board.png
cohub boards export <board> --items a,b -o /tmp/part.png       # or --frame <id>, --rect x,y,w,h
cohub boards export <board> --animation intro --at 0:10s:500ms -o /tmp/frame-%d.png
cohub boards export <board> --animation intro --at 1s,5s,9s --camera --size 1600x900 -o /tmp/preview-%d.png
cohub boards inspect <board> --animation intro --at 1s,5s,9s --json
```

Use `--camera` to preview the audience view and `inspect` to check layout.
If something looks wrong, check the time and framing first.

## History

```bash
cohub boards history <board>                 # recent versions
cohub boards history <board> --restore 12    # return to a version, as a new write
```

## Safety

- Read the schema rather than guessing field names; `--dry-run` costs nothing.
- Confirm with the user before deleting items or animations, or restoring a version
  over their work.
- `export` refuses to overwrite without `--force`; never force onto an unknown path.
