# Ember

A night camp on a live Board. Walk to the fire and talk to whoever is near; pin
paper cards on the meadow; drag one into the flames and watch a spark carry it
up into the sky as a star. Your stars link into your own constellation. Wake the
fire spirit and it joins the evening: it answers, names new stars and weaves two
people's cards into a third. Turn on your camera and a live video bubble floats
above your camper, following you around the Board.

Ember brings [Campfire](https://cohub.live/tzwm/cohub-example-apps/w/campfire)'s
rooms and voices together with
[NETA World](https://cohub.live/tzwm/cohub-example-apps/w/neta-world)'s living
Board. The whole scene is a Board document: the fire, the trees, the cards and
the stars are ordinary Board items, and the campers and effects are Board
scripts. It is a standalone Svelte App built on public packages and can be
copied out of this repository.

## What it demonstrates

| Capability | Where it shows |
| --- | --- |
| Board as the scene | `@neta-art/cohub/board` editor and stage render the camp; native `effect` items are the flames, sparks, firelight, fireflies and star glows |
| Board scripts | `campers.js` draws every camper, bubble and the spirit as temporary scene items; `fire.js` breathes with the fire's heat; `fx.js` plays card flights, sparks and thrown wood |
| `scriptCapabilities` | Scripts read the live simulation (`camp.cast`, `camp.fire`, `camp.fx`) and act on it (`camp.feed`, `camp.poke`): tap the fire to add wood, tap yourself to wave |
| Previews and live strokes | Someone else's card drag and their pen stroke appear while they happen, without touching the document |
| Room events as the document | Cards, moves, burns, ink, wood and star names are room events; every client folds them into the same Board in room order |
| Optimistic writes | Your own events apply at once and reconcile by `clientEventId` when the room confirms them |
| Snapshots | A keeper compacts the camp into gzipped snapshot events before history runs out of events or bytes; a fresh room carries the last camp over |
| `room.rtc()` | Poses and drags on `latest` channels, emotes on `reliable`; `select()` shares a 16-track budget between voices and nearby cameras |
| Camera bubbles | Opt-in capture, simulcast publication, up to four visible nearby videos, distance-based quality; muted DOM video follows the Board camera without document writes |
| Proximity audio | Voices panned and attenuated by where campers stand on the Board; everyone inside the firelight shares one conversation |
| `room.invite()` + App Actions | The spirit is `.cohub/actions/spirit.js`, running as the App owner; it rebuilds the camp with the same reducer and acts only through camp events |
| Degradation | Without WebRTC, poses and drags fall back to `room.send`; cards, chat and the spirit keep working |

## How it is put together

```
src/
  camp/            The camp as data, with no browser or network
    protocol.ts      Event names, limits, validation of everything that arrives
    state.ts         The reducer: room events → cards, stars, ink, embers; snapshots
    restore.ts       Newest complete snapshot + the events after it
    scene.ts         How the camp looks as Board items (scenery, cards, stars, ink)
    document.ts      Camp state → Board document, cached by entity identity
    world.ts ink.ts  Geometry, hearing, star placement; compact stroke encoding
  engine/          The running App
    camp.svelte.ts   Phases, confirmed + pending state, actions, the frame loop
    board.ts         Editor and stage, input (walk, drag, ink), camera, previews
    world.ts         Bodies, speech and effects; the script capabilities
    media.svelte.ts  Microphone and camera lifecycle, spatial voice mix, media selection
    spirit.svelte.ts Summoning and watching the spirit Action
    storage.ts       Local camp cache for the first screen, profile, grant reload
  net/             Room session, pose codec, WebAudio mixer
  ui/              Lobby, top bar, dock, log, star tooltip
public/scripts/   Board scripts: campers, fire, fx
spirit/           The fire spirit App Action, bundled to .cohub/actions/spirit.js
preview/          A stand-in host for local development (not built)
```

Three rules keep it honest:

- **The Board is derived, never edited.** A drag or a stroke on the Board becomes
  a camp event; the next document comes from the camp. Nothing the editor does is
  saved directly.
- **Every client folds the same events into the same camp.** Cards are placed,
  clamped and turned into stars by the reducer, so there is nothing to reconcile
  after a reconnect, only to replay. The spirit runs the very same reducer.
- **Frequent and disposable goes peer to peer; anything that must survive goes
  through the room.** A lost pose is replaced by the next one; a lost burn would
  lose a star, so burns are room events.

## Data

Room history keeps the newest 1,000 events and 512 KB, and a room lives at most
a day. The longest-seated camper writes a snapshot every 320 events or 160 KB,
so the oldest surviving event is always a complete camp. Snapshot parts are
grouped by a key, so two keepers racing never mix their parts. Each device keeps
the last camp it confirmed for 20 hours; if a room has expired, the keeper
carries that camp into the new room as its first snapshot. The cache only ever
holds confirmed state, and a corrupt or partial snapshot is ignored in favour of
the next one. Snapshots are cooperative room state, not server-signed checkpoints:
room members can publish them, so use this demo with trusted participants. The
room confirms event delivery, not snapshot authorship or correctness. Inflation
is bounded to 2 MB; persistent or adversarial use needs server-owned Board storage.

## Costs

The App owner pays for the spirit: a visit is a few dozen short completions and
optional speech clips, bounded to 25 minutes, 24 lines, 8 woven cards and 16 star
names, and it leaves when the camp empties or falls quiet (`spirit/lib/mind.ts`).
At most four spirits run at once and one per viewer (`spirit/lib/quota.ts`).
Viewers pay nothing and grant microphone and camera access separately. Opening a
camera never opens the microphone. Closing it or leaving stops capture, including
streams that arrive after a pending permission request. Device-grant reloads retain
the room and the requested device choices.

Videos use 640×480 capture at 20 fps (24 fps maximum). Voices take receiver priority;
only the nearest four on-screen cameras within 720 Board units are selected.
Camera quality drops with distance, and hidden App windows unsubscribe from remote
video. Video elements are muted; all sound continues through the spatial mixer.

## Develop

```bash
cd cohub-apps/ember
npm install
npm run dev     # http://localhost:5173/preview.html
```

`preview.html` runs the App against a stand-in host: tabs of one browser share a
room through a `BroadcastChannel`, with a scripted spirit that names stars and
weaves cards through the same events. There is no relay there, so it shows the
fallback path. `?lang=zh` previews Chinese. Camera capture can be tested locally;
without RTC, the App labels it as a preview visible only to you.

Real media transmission, Cohub device-grant reloads and the spirit Action require
a published App. Verify everything local with:

```bash
npm run check   # typecheck, lint, unit tests, build
```

## Publish

```bash
npm run build
cohub apps publish ember --dir cohub-apps/ember/dist --hide-cohub-bar --visibility space
```

No App scopes are needed: rooms, peer channels, devices and Actions are runtime
capabilities. Start with Space visibility and trusted room members; making the App
public does not make peer-written snapshots authoritative. The spirit Action
requires Linux `flock` (provided by the sandbox) for process-scoped quota locking,
and runs with the SDK bundled with the sandbox's
`cohub` CLI, which needs `@neta-art/cohub-cli` 10 or newer for `client.rooms`.

Open the App from a Space and everyone in that Space meets at the same camp;
share `?room=<code>` to meet anywhere else.
