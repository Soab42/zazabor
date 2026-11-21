# Meet: calls and meetings hosted by Zazabor Home

Zazabor Home's **Meet** section runs voice calls, group video calls and scheduled team meetings,
like Teams or Google Meet, and records every meeting automatically. The PC is the host. Invited
people join from a browser link, with nothing to install.

Decisions (user, 2026-11-21):

- Guests join with a **browser link through the PC**. Zazabor serves the meeting page itself and
  opens a free **Cloudflare quick tunnel** (`cloudflared`) so people outside the Wi-Fi can reach
  it. The tunnel only forwards signalling and the page; the audio and video go peer to peer.
- "Audio calling" means **internet voice calls** (1-to-1 or more) on the same system as meetings:
  a call is a meeting that starts with cameras off.
- **Auto recording** is on by default for every meeting. Everyone sees that the meeting is recorded
  before joining and while in it. That is required, not optional: recording people without telling
  them is illegal in many places.

## Why the room runs in a browser

The meeting itself (camera, mic, WebRTC) runs in a Chromium-family browser, not in Zazabor's own
web view. WebKitGTK has WebRTC, but only with GStreamer's `webrtcbin`, `nice`, `srtp` and `dtls`
plugins, and those aren't on a normal desktop. So:

- **The host** joins in a detached Chrome/Chromium/Edge/Brave **app window**
  (`--app=<url> --user-data-dir=<app data>/meet-browser`): no tabs, no address bar, a window of
  its own. Without one of those browsers, Zazabor uses the default browser (`xdg-open`).
  The host opens `http://127.0.0.1:<port>/…`. Localhost counts as a secure context, so the camera
  works without HTTPS.
- **Guests** open `https://<random>.trycloudflare.com/m/<code>` in any modern browser on a phone
  or computer.

## Parts

| Part | Where |
| --- | --- |
| Meetings, invites, recordings (SQLite `meet.db` in the app data dir) | `src-tauri/src/meet/store.rs` |
| HTTP + WebSocket server on `127.0.0.1` (port 47230 or the next free one); signalling, lobby, recording upload | `src-tauri/src/meet/server.rs`, `room.rs` |
| The meeting page served to browsers (plain HTML/CSS/JS, embedded with `include_str!`) | `src-tauri/src/meet/web/` |
| Cloudflare quick tunnel | `src-tauri/src/meet/tunnel.rs` |
| Opening the host's app window | `src-tauri/src/meet/browser.rs` |
| Invitation e-mails with a calendar invite (`.ics`) through a Mail account | `src-tauri/src/meet/invite.rs` |
| Tauri commands + events | `src-tauri/src/meet/mod.rs` |
| The Meet section in the app | `src/modules/meet/` |

The server binds **127.0.0.1 only**. Guests reach it through `cloudflared`, which connects
locally. A request that carries a `Cf-Connecting-Ip` header came through the tunnel.

## Data model

```ts
interface Meeting {
  id: string;            // 16 hex
  code: string;          // join code: 10 chars from [a-z2-9], shown as abc-defg-hij
  title: string;
  kind: "meeting" | "call";   // a call starts with cameras off
  startsAt: number | null;    // Unix ms; null = instant ("Meet now")
  minutes: number;            // planned length (default 30, call 0)
  autoRecord: boolean;        // default true
  lobby: boolean;             // guests wait until the host admits them (default true)
  invitees: Invitee[];
  createdAt: number;
  live: boolean;              // someone is in the room now
  hostIn: boolean;            // the host is in it
  people: number;             // how many are in the room (lobby not counted)
  waiting: number;            // in the lobby
  recording: boolean;         // a recording is being written now
}
interface Invitee { email: string; name: string; sentAt: number | null; error: string | null }
interface Recording { id: string; meetingId: string; title: string; path: string; startedAt: number; endedAt: number | null; bytes: number }
interface MeetState {
  port: number;
  tunnel: { state: "off" | "starting" | "on" | "error"; url: string | null; error: string | null };
  browser: string | null;     // the browser the host's window opens in, e.g. "Google Chrome"; null = default browser
  recordingsDir: string;      // ~/Videos/Zazabor Meetings
  stun: string[]; turn: { url: string; username: string; credential: string } | null;
}
```

Links: `joinUrl = <tunnel url or http://<LAN ip>:<port>>/m/<code>`. The LAN address works only for
the camera on `localhost`, so invitations always use the tunnel URL. With the tunnel off, the
section says so and offers to start it.

## Tauri commands (what `src/modules/meet/api.ts` calls)

| command | args | returns |
| --- | --- | --- |
| `meet_state` | — | `MeetState` (starts the server on first call) |
| `meet_list` | — | `Meeting[]` (upcoming first, then past, newest first) |
| `meet_create` | `{ title, kind, startsAt, minutes, autoRecord, lobby, invitees: {email,name}[] }` | `Meeting` |
| `meet_update` | `{ id, …same fields }` | `Meeting` |
| `meet_delete` | `{ id }` | — (refuses while live) |
| `meet_join_url` | `{ id }` | `string` (starts the tunnel if it's off and waits for it, up to 20 s) |
| `meet_open` | `{ id }` | — (opens the host window on `http://127.0.0.1:<port>/m/<code>?host=<hostToken>`) |
| `meet_invite` | `{ id, accountId, message }` | `Invitee[]` (sends the e-mails; each invitee's `sentAt`/`error` set) |
| `meet_end` | `{ id }` | — (ends the meeting for everyone, stops the recording) |
| `meet_recordings` | — | `Recording[]` |
| `meet_recording_delete` | `{ id }` | — (deletes the file too) |
| `meet_tunnel` | `{ on: bool }` | `MeetState` |
| `meet_settings` | `{ stun, turn }` | `MeetState` |

Events: `meet-changed` (no payload: reload the list/state) and `meet-knock`
`{ meetingId, title, name }`, sent when a guest waits in the lobby and the host window isn't open.
The Meet section shows a toast with **Open meeting**.

**Scheduled meetings.** Five minutes before `startsAt`, Zazabor makes sure the tunnel is on. If its
URL differs from the one in the invitation (quick-tunnel URLs change when the tunnel restarts), it
e-mails the invitees **"<title> is starting: join here"** with the new link. It also shows a
desktop notification to the host with **Start**. While a meeting is scheduled or live, the
tunnel stays on.

## The meeting page (`/m/<code>`)

One page, three stages:

1. **Pre-join.** A camera preview, mic/camera toggles, device pickers and a name field (the host's
   name comes from the system user's full name). When the meeting records, a banner says:
   *"This meeting is recorded by the host."* The button reads **Join** (or **Ask to join** when
   the lobby is on and you're a guest).
2. **Lobby.** "Waiting for the host to let you in…". The host sees knocks with Admit / Deny, and
   Admit all.
3. **Room.**
   - A video grid that lays itself out by count; a screen share takes the big stage, with the
     others in a strip.
   - A name label and mic-off icon on each tile, and a ring on whoever is speaking (WebAudio
     level).
   - A bottom bar: mic, camera, share screen, raise hand, reactions (👍 ❤️ 😂 🎉 👏), chat,
     people, leave.
   - The host also gets: Admit, mute someone (asks their page to mute; it can't force it), remove,
     **End for everyone**, and pause/resume recording.
   - A red **● REC** pill shows to everyone while recording.
   - Chat messages also go into the recording's side file (`.chat.txt`).

### Signalling (WebSocket `/ws/<code>`, JSON text frames)

Client → server:

| t | fields |
| --- | --- |
| `hello` | `name, host? (hostToken), audio, video` → the server answers `welcome` or `lobby` |
| `signal` | `to, data` (SDP offer/answer or ICE candidate, relayed as-is) |
| `state` | `audio, video, hand, sharing` |
| `chat` | `text` |
| `react` | `emoji` |
| host: `admit` / `deny` | `id` |
| host: `mute` / `remove` | `id` |
| host: `end` | — |
| host: `rec` | `on` (pause/resume) |

Server → client:

| t | fields |
| --- | --- |
| `welcome` | `id, peers: Peer[], meeting: {title, kind, recording}, ice: RTCIceServer[], host: bool` |
| `lobby` | — (wait) |
| `admitted` | then `welcome` |
| `denied` / `removed` / `ended` | — (page shows why; socket closes) |
| `peer-joined` | `peer: Peer` |
| `peer-left` | `id` |
| `peer-state` | `id, audio, video, hand, sharing` |
| `knock` / `knock-gone` | `id, name` (host only) |
| `signal` | `from, data` |
| `chat` | `from, name, text, at` |
| `react` | `from, emoji` |
| `mute-request` | — |
| `rec` | `on` |

`Peer = { id, name, host, audio, video, hand, sharing }`. The newcomer sends the offers (to each
peer in `welcome`), so two sides never offer at once. ICE restarts on `failed`. ICE servers:
`stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`, plus an optional TURN server from
Meet settings. Without TURN, a guest behind a strict (symmetric) NAT can't get media through; the
page says "Couldn't connect to <name>'s video" instead of hanging.

This is a full mesh. It's good for about 8 people with video; past that, the page lowers the
resolution it sends (`maxBitrate` per sender: 1.2 Mbps ≤ 4 people, 600 kbps ≤ 8, 300 kbps beyond).
It allows at most 16 people.

### Recording (auto)

The **host's page** records, because it already receives every stream:

- A 1280×720, 30 fps `<canvas>` draws the same layout as the grid, with names, the screen share on
  the stage, and the REC time.
- WebAudio mixes every participant's audio with the host's own mic into one track.
- `MediaRecorder` (`video/webm;codecs=vp9,opus`, falling back to vp8) makes 2-second chunks that
  go to `POST /rec/<code>?host=<token>&rec=<recId>&seq=<n>`. The server appends them in order to
  `~/Videos/Zazabor Meetings/<title> <YYYY-MM-DD HH.mm>.webm`. A crash loses 2 seconds, not the
  meeting.
- Recording starts when the host joins if `autoRecord` is on, and stops on End, when the host
  leaves, or on pause. Resuming starts a new part (`… (2).webm`).
- The Meet section lists recordings, plays them in Zazabor's Video player, and shows them in Files.

## Invitations

`meet_invite` sends through a Mail account (`mail::mail_send` machinery, the account the user
picks). Each e-mail has:

- an HTML body (title, time in the invitee's words, **Join meeting** button, the meeting code and
  "This meeting will be recorded" when it is);
- a plain-text part;
- `invite.ics` (`METHOD:REQUEST`, `VEVENT` with `UID=<id>@zazabor`, `DTSTART`/`DTEND` in UTC,
  `LOCATION`/`URL` = the join link, `ORGANIZER` = the account's address, one `ATTENDEE` per
  invitee). Gmail and Outlook then offer to add it to the calendar.

An instant meeting or call has no `.ics`: the e-mail just says "Join now".

## The Meet section (`src/modules/meet/`)

It looks like the other sections (`docs/DESIGN.md`: glass sidebar, content on the backdrop).

- **Sidebar:** Meet now, New call, Schedule. Below them: Upcoming / Past / Recordings.
- **Meet now:** creates an instant meeting, opens the host window, and copies the link.
- **New call:** an instant call (cameras off). Asks for e-mail addresses (optional), sends "X is
  calling you: join", opens the window, and copies the link.
- **Schedule:** a sheet with title, date, time, length, invitees (with completion from Mail
  contacts, `mail_contacts`), auto-record (on), lobby (on), call or video meeting, and the Mail
  account to send from. Saving sends the invitations.
- **Meeting card:** title, when, invitees with sent ✓/error, Copy link, Start/Join, Send invites
  again, Edit, Delete. While live it shows people, lobby and REC, and **End**.
- **Recordings:** a grid with title, date, length and size. Play (Video module), Show in Files,
  Delete.
- **Settings (Meet):** tunnel on/off with its address, recordings folder, STUN list, TURN server.
- `meet-knock` toast over any section: "<name> is waiting to join <title>" → **Open meeting**.

## cloudflared

Zazabor looks for `cloudflared` on `PATH`, then in `~/.local/bin`, then in the app data dir.
Otherwise it downloads `cloudflared-linux-amd64` (or `-arm64`) from the latest
`github.com/cloudflare/cloudflared` release into the app data dir and makes it executable. It
checks the file's SHA-256 against the checksum the release lists. It runs
`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` and reads
`https://….trycloudflare.com` from its output. If the tunnel dies, Zazabor restarts it with
backoff and sends `meet-changed`. It stops when Zazabor quits.

## As built (additions to the contract)

- `welcome` also carries `name` (the cleaned name) and `meeting.autoRecord`, `meeting.lobby`. A full room answers `full`
  (then closes); an unknown code answers `error`; a bad or tunnelled host token answers `denied` with `reason: "token"`.
  `chat` and `react` go to everyone including the sender. The page sends `{t:"ping"}` every 20 s (ignored).
- The host token is only honoured on the local address: a request with `Cf-Connecting-Ip` is never a host.
- `GET /api/info/<code>[?host=<token>]` -> `{title, kind, recorded, lobby, host, hostName}` feeds the pre-join stage.
- Each peer connection carries three transceivers in a fixed order (audio, camera, screen), so a screen share needs no renegotiation.
- `meet_join_url` returns an error (not a LAN link) when the tunnel isn't up after 20 s.
- Commands take plain camelCase arguments (`startsAt`, `autoRecord`, `accountId`), not one wrapper object.
