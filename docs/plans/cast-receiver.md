# Cast to Zazabor: the PC as a TV for the phone

Zazabor shows up as a screen on the Wi-Fi, so a phone can send it something to play the way it
would send it to a smart TV. Every source plays through the normal Video player, with its glass
controls, and the phone keeps working as the remote.

| From | How Zazabor appears | Protocol |
| --- | --- | --- |
| VLC (Android, desktop) "Play on…" | a Cast device | Cast v2 over TLS on 8009, mDNS `_googlecast._tcp` |
| YouTube app "Cast" / "Watch on TV" | a TV with YouTube | DIAL (SSDP + HTTP) and YouTube's lounge pairing; played with yt-dlp |
| BubbleUPnP, Web Video Caster, Samsung Gallery, Windows "Cast to device", Kodi remotes… | a DLNA renderer | UPnP AV MediaRenderer (SSDP + SOAP) |
| The phone's whole screen | in the Zazabor Cast app | `ZMIR` over TCP 47212, mDNS `_zazabor-mirror._tcp` |

Android's own "Cast screen" button cannot target Zazabor: the phone checks a certificate that
Google signs only for certified Cast hardware. YouTube and Chrome check it too, which is why
YouTube goes through DIAL instead. VLC has its own Cast code and does not check the certificate.

## Turning it on

Video → Network Streams → **Cast to this PC** (and Settings → Video → Cast). Off by default: the
receiver opens ports on the network. The name defaults to "Zazabor on ‹hostname›". The settings
live in `config.video.ext.receiver` (`enabled`, `name`, `id`, `trusted`, `ask`). The main window
starts the services with `cast_receiver_start` when it loads. Extra windows never do.

The first cast from a new device asks first ("Pixel 7 wants to play “Song” from YouTube: Allow /
Always allow / Decline"). Choosing "Always" adds the device's key to `trusted`.

## Desktop layout (`src-tauri/src/cast/`)

- `mod.rs`: the hub. The receiver's services start and stop together. There is one session
  (the cast now playing), and `play / pause / seek / volume / stop / status` act on it. The hub
  emits `cast-play` to the main window. When there is no main window, the play request waits
  for `cast_pending`. A session ends when its source stops it, another cast replaces it, or the
  user plays something else in Zazabor.
- `http.rs`: a tiny HTTP/1.1 server (one thread per connection, `Connection: close`) on one port
  shared by DLNA and DIAL.
- `ssdp.rs`: UPnP discovery on 239.255.255.250:1900. It answers M-SEARCH for the DLNA renderer
  and the DIAL server and sends NOTIFY alive/byebye.
- `mdns.rs`: advertises `_googlecast._tcp` and `_zazabor-mirror._tcp` (crate `mdns-sd`).
- `castv2.rs`: the Cast receiver for VLC. It is a TLS server on 8009 with a self-signed
  certificate made at startup.
- `dlna.rs`: MediaRenderer (AVTransport, RenderingControl, ConnectionManager).
- `youtube.rs`, `ytdlp.rs`: DIAL app "YouTube", lounge pairing, the "Link with TV code" code, and
  yt-dlp (downloaded once from its GitHub release and checked against SHA2-256SUMS).
- `mirror.rs`: takes the phone's H.264 + AAC and muxes them into MPEG-TS. libVLC plays the
  result from `http://127.0.0.1:‹port›/mirror/‹id›.ts` with low caching.

Sources pass libVLC media options (e.g. `:input-slave=` for YouTube's separate audio stream,
`:network-caching=150` for mirroring) through `cast::media_options(url)`. `video::open` reads
them, so the page only ever sees the address.

## Cast v2 (what VLC needs)

Framing: a 4-byte big-endian length, then a protobuf `CastMessage` (fields 1 version=0,
2 source, 3 destination, 4 namespace, 5 payload type, 6 utf8, 7 binary). VLC sends
`DeviceAuthMessage{challenge}`. Any `response{signature, certificate}` satisfies it. Then:

1. `connection CONNECT` → `receiver GET_STATUS` → `RECEIVER_STATUS` (no apps, or ours)
2. `LAUNCH CC1AD845` → `RECEIVER_STATUS` with `{appId, sessionId, transportId, namespaces}`
3. `CONNECT` to the transport → media `LOAD {contentId: http://phone…, streamType LIVE,
   autoplay false}` → `MEDIA_STATUS` (same `requestId`) PAUSED/BUFFERING with a `mediaSessionId`
4. `PLAY`, `PAUSE`, `SET_VOLUME`, `STOP`, `GET_STATUS`. Each reply carries the request's
   `requestId`, and unprompted updates carry `requestId: 0`. VLC seeks by sending a new LOAD.
   `PING` gets a `PONG`. Zazabor pings every 5 s, because VLC drops the link after 6 s of silence.

Every `MEDIA_STATUS` reply must carry the request's `requestId`. VLC ignores other replies while a
request is pending.

## Mirroring protocol (`ZMIR`, TCP 47212)

Phone → PC: the line `ZMIR/1\n`, then one JSON line
`{"name":"Pixel 7","id":"<stable id>","width":1080,"height":2400,"audio":true,"sampleRate":48000,"channels":2}`.
The PC answers one JSON line: `{"ok":true}` or `{"ok":false,"reason":"…"}`. The phone waits up
to 60 s for it, because the PC may be asking its user.

Then packets, phone → PC: `u8 kind` (1 video, 2 audio), `u8 flags` (1 key frame, 2 codec
config), `u64 pts_us` BE, `u32 len` BE, `len` bytes. Video is H.264 Annex-B (SPS/PPS as codec
config). Audio is raw AAC-LC frames, with the AudioSpecificConfig as codec config.

PC → phone, after the answer: newline-terminated lines. `key` asks for a key frame (a new viewer
started). `bye` means the PC stopped mirroring. Either side closes the socket to end.

## Phone app (`mobile-cast/`)

"Zazabor Cast" is a native Kotlin Android app (minSdk 29), separate from the Wallet app. It lists
PCs found with NsdManager and accepts a typed address. **Mirror** asks for MediaProjection and
runs a foreground service of type `mediaProjection`. That service feeds a VirtualDisplay into an
H.264 MediaCodec and, with AudioPlaybackCapture, captured audio into an AAC encoder.
