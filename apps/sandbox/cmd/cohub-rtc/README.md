# Room RTC helper

`cohub-rtc` is a standalone Go/Pion executable launched on demand by `cohub rooms rtc`. It shares the sandbox Go module for dependency and build tooling reuse; its import graph does not include Display, capture providers, or the sandbox daemon. Shared timestamp and logging primitives live in `rtccore`. Sandbox keeps its H264, congestion-control, capture, and input policies.

Build locally:

```sh
cd apps/sandbox
go build -trimpath -ldflags '-s -w' -o /tmp/cohub-rtc ./cmd/cohub-rtc
cohub rooms rtc <room-id> --helper /tmp/cohub-rtc --channel chat
```

The CLI retains authentication, token refresh, the hosted seat, and the Room WebSocket. The helper owns WebRTC, serialized negotiation, publication/subscription reconciliation, media, and DataChannels. File descriptors 3 and 4 carry bounded NDJSON control messages. Credentials do not enter the helper. Media uses stdin, stdout, or files directly; it does not pass through Node or JSON/Base64. The CLI tracks opened server sessions and awaits their deletion even if helper initialization fails or the process crashes. Disconnecting does not leave the room.

## Inputs

```sh
# Raw input: FFmpeg is needed only for conversion.
cohub rooms rtc <room-id> --audio speech.pcm --rate 48000 --channels 1
cohub rooms rtc <room-id> --video clip.i420 --size 640x360 --fps 30

# Encode once upstream, then transport without decoding or re-encoding.
ffmpeg -i speech.mp3 -c:a libopus -ar 48000 -f ogg - \
  | cohub rooms rtc <room-id> --audio - --audio-format opus
ffmpeg -i clip.mp4 -an -c:v libvpx -deadline realtime -f ivf - \
  | cohub rooms rtc <room-id> --video - --video-format vp8

printf '%s\n' '{"text":"Hello"}' \
  | cohub rooms rtc <room-id> --channel chat --data-input -
```

PCM is signed 16-bit little-endian; I420 needs even dimensions. Encoded input supports one mono/stereo Ogg Opus stream or VP8 IVF. Encoded inputs are paced from packet duration or media timestamps, so files and live pipes use the same interface. Ogg checksums, page continuity, packet sizes, and IVF frame sizes are validated. Only one input can consume stdin. EOF withdraws that media publication while reception continues.

A named DataChannel uses the browser SDK's five-byte framing and reliable/latest delivery policy. JSON input is limited to 64 KiB per message. Incoming binary data is reported as `{ "base64": "..." }`. Slow control or media consumers fail explicitly; input is bounded and reliable data is not silently overwritten by newer messages.

Receive-only sessions reconnect and refresh subscriptions. If a connection fails while file/pipe or DataChannel input is configured, the command fails explicitly instead of replaying consumed input or stale speech. A realtime producer can start a fresh connection and provide fresh input. There is no automatic device capture, mixing, or permanent recording.

## Reception and framing

```sh
# Keep original received RTP and codec/timestamp metadata.
cohub rooms rtc <room-id> --output ./received --max-bytes 1073741824

# Decode only when a model needs PCM/I420 frames.
cohub rooms rtc <room-id> --output - --receive-format raw --receive-size 640x360
```

`--output` is opt-in. Each received track segment gets an exclusively created `.rtc` file; `--output -` multiplexes the same frames to stdout and moves NDJSON events to stderr. The default quota is 1 GiB across all segments for the invocation. `--max-bytes 0` removes that limit. Existing files are never overwritten. Network loss cannot be reconstructed.

Each frame contains:

1. A four-byte unsigned big-endian JSON header length.
2. A UTF-8 JSON header with `version: 2`, `segment`, `participantId`, `name`, `kind`, `format`, and `bytes`.
3. Exactly `bytes` payload bytes.

Consumers should reject headers over 64 KiB and payloads over 128 MiB before allocating. The default `format: "rtp"` payload is one complete RTP packet, including its header. Metadata includes `codec`, `clockRate`, `channels`, `fmtp`, RTP `timestamp`, `sequence`, `marker`, and Unix-microsecond `receivedAt`. RTP timestamps use the negotiated clock and wrap at 32 bits; arrival timestamps are not capture timestamps or cross-track synchronization guarantees. Packet archives preserve packet ordering as received and are not directly playable media containers.

`--receive-format raw` uses external FFmpeg with bounded pipes. Opus becomes 48 kHz stereo `s16le`; VP8/VP9/AV1/H264 become `i420` at `--receive-size` (default 640x360). Raw headers include sample rate/channels or width/height and a Unix-microsecond decode-completion `timestamp`. Media decoding may conceal loss, and video is scaled explicitly to the requested dimensions. An unsupported codec fails instead of silently producing another format. Raw frames remain framed in `.rtc` files or stdout; consumers extract the payload before giving it to a model.

This replaces the unpublished Node adapter. `--adapter` and the native worker are removed. Input flags remain compatible; received `.pcm`/`.i420` plus metadata sidecars and version-1 stdout frames are replaced by the single version-2 format. Browser SDK RTC APIs and the injectable PeerConnection factory remain available.

## Distribution

The CLI resolves `--helper` / `COHUB_RTC_BIN` first. Otherwise it downloads a versioned gzip binary, checks SHA-256, installs it atomically, and verifies the cached executable on reuse. Linux and macOS amd64/arm64 builds use `CGO_ENABLED=0`; FFmpeg is external and is not bundled or downloaded.

`.github/workflows/rtc-binaries-build.yml` follows the global stable release tags (`vX.Y.Z`), like sandboxd. On a release tag it compares helper sources, `rtccore`, Go dependencies, license notices, and the workflow against the highest stable ancestor tag before the release commit. Unchanged releases skip building and publishing; the first release builds all four targets. PRs and pushes to `main` run verification and build all four targets when helper, shared RTC, dependency, license, or workflow paths change. Manual runs on branches also build verification artifacts. These branch and PR runs do not publish to the CDN. Tag runs publish under `https://public.cohub.live/rtc/<global-tag>/`. Sandbox RTC policy changes trigger integration verification but do not by themselves require a helper release.

Publish helper artifacts first, then set `RTC_HELPER_VERSION` in the CLI to that published global tag and release the CLI through the existing npm workflow. The CLI keeps using its pinned version until that constant is updated; global releases without RTC changes do not need a new pin. CLI prepublish checks reject an unset pin or missing platform artifacts. The initial pin is intentionally unset until the first global release contains the helper. Use `--helper` for local builds, or `COHUB_RTC_VERSION` and `COHUB_RTC_CDN_BASE_URL` to test published staging artifacts. Do not overwrite released tags or artifacts; publish fixes under a new global version.

## Verification

```sh
cd apps/sandbox
go test -race ./cmd/cohub-rtc ./rtc ./rtccore
go vet ./cmd/cohub-rtc ./rtc ./rtccore
```

The integration test runs the real Room helper signaling logic against a local Pion peer with bidirectional audio, video, and DataChannels, raw input conversion, RTP recording, and raw output decoding. It does not certify Cloudflare SFU behavior or browser deployment interoperability; those require a configured deployment and a dedicated Room.
