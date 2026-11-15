# Phone Link: the phone on the PC

Zazabor's **Phone** section works like Windows' Phone Link. A paired Android phone shows its
messages, calls, photos, files and notifications on the PC. You can send texts, drag files either
way, place and answer calls through the PC's speakers and mic over Bluetooth, and mirror the
phone's screen.

The phone side is the **Zazabor Link** app. It is the Zazabor Cast app (`mobile-cast/`, package
`dev.soab.zazabor.cast`) grown into a companion. Its launcher label becomes "Zazabor Link". The
package stays the same so installs and prefs carry over.

| Feature | Path | Needs the app |
| --- | --- | --- |
| Messages (SMS/MMS text), send texts | Wi-Fi link (`ZLNK`) | yes |
| Call history, contacts | Wi-Fi link | yes |
| Notifications, reply and dismiss | Wi-Fi link | yes |
| Photos (recent), file browser, send/receive files, drag and drop | Wi-Fi link | yes |
| Battery, signal, ring my phone, clipboard | Wi-Fi link | yes |
| Dial, answer, decline, hang up, keypad, caller ID, call audio on the PC | Bluetooth HFP (Zazabor is the hands-free unit) | no |
| Screen mirroring | the existing `ZMIR` stream (docs/plans/cast-receiver.md), started over the link | yes |

Code: desktop `src-tauri/src/phonelink/` (Rust) and `src/modules/phone/` (page). Never put it in
`src-tauri/src/cast/`, which belongs to the Cast receiver. Mirroring reuses `cast::mirror` as it is.

## 1. The Wi-Fi link (`ZLNK/1`)

### Discovery

The PC listens on TCP **47213** (or the next free port) and advertises `_zazabor-link._tcp` over
mDNS (crate `mdns-sd`) with TXT `name` (the PC's display name), `id` (the PC's stable id, 32 hex
characters, kept in the phone-link database) and `v=1`. The phone browses with the same
NsdManager code the Cast app uses for `_zazabor-mirror._tcp`. It also accepts a typed address
`host[:port]`.

### Identity

The phone's identity is the Cast app's `mirrorSecret` (`cast.xml` prefs). On the wire the phone
sends only **`phoneId` = the first 32 hex digits of SHA-256(mirrorSecret as UTF-8 text)**. That is
the same trust key Cast stores. The secret itself never goes over the link.

### Handshake (plaintext, then sealed)

The phone opens TCP and writes the line `ZLNK/1\n`, then one JSON line:

```json
{"phoneId":"<32 hex>","name":"Pixel 7","model":"Google Pixel 7","nonce":"<base64 16 random bytes>","commit":"<base64 32>","pair":false}
```

The PC answers one JSON line. Each answer below is one possible case:

- Known phone: `{"ok":true,"pcId":"…","name":"Zazabor on host","nonce":"<base64 16>"}`
- Unknown phone that sent `"pair":false` (a background reconnect):
  `{"ok":false,"unknown":true,"pcId":"…","name":"…","reason":"…"}`, then close. The phone stops
  retrying and shows "This PC forgot this phone. Pair again."
- `"pair":true` (the user tapped Pair): `{"ok":true,"pair":true,"pcId":"…","name":"…","nonce":"…","pub":"<base64 65-byte P-256 uncompressed point>"}`
  The phone answers with the line `{"pub":"<base64 65 bytes>"}`.

**Commitment (required).** The phone makes a fresh P-256 key pair for every connection. It puts
`commit = base64(SHA-256(phonePub))` (the 65-byte uncompressed point) in its hello, before it has
seen the PC's key. When pairing, the PC checks `SHA-256(pub) == commit` on the phone's `pub`
line. If they don't match, or the hello had no `commit`, it sends `{"ok":false,"reason":"…"}`,
closes the connection, and never computes or shows a code. Without this, someone in the middle
posing as the phone could try about a million keys after seeing the PC's key, until the two
six-digit codes matched. (The PC sends its key before seeing the phone's, so the PC needs no
commitment.)
- Refused: `{"ok":false,"reason":"…"}`, then close.

**Pairing (numeric comparison).** Both sides do ECDH P-256 (ring `agreement::ECDH_P256` and
Android `KeyAgreement "ECDH"`) to get the 32-byte shared secret `z`. Then:

- `linkKey = HKDF-SHA256(ikm = z, salt = phoneNonce ‖ pcNonce, info = "zlnk pair", 32 bytes)`
- `code = (u32 BE from HKDF-SHA256(ikm = z, salt = phoneNonce ‖ pcNonce, info = "zlnk code", 4 bytes)) mod 1_000_000`.
  Show it as six digits with a space in the middle: `482 913`.

Both screens show the code: "Does your phone show 482 913?" with Pair / Cancel. The PC sends the
`phone-pair` event. Each side then sends one sealed message, `{"t":"pair.ok"}` or
`{"t":"pair.no"}`, using the session keys below with `linkKey`. Pairing completes only when both
sides send `pair.ok`. Then each side stores `linkKey`: the PC keeps it in its database keyed by
`phoneId`, and the phone keeps it in prefs `link.xml` as `key_<pcId>`. The PC gives up after 120 s.

**Session keys.** For every connection, including pairing:
`k = HKDF-SHA256(ikm = linkKey, salt = phoneNonce ‖ pcNonce, info = "zlnk session", 64 bytes)`.
The first 32 bytes are the phone→PC key and the last 32 are PC→phone. Use ChaCha20-Poly1305
(ring `CHACHA20_POLY1305`; Android `Cipher "ChaCha20/Poly1305/NoPadding"`, API 28+). The nonce is
12 bytes: 4 zero bytes, then a u64 BE counter that starts at 0 for each direction and rises by
one per frame. AAD is empty.

A known phone proves itself with its first sealed frame, `hello` (§1.3). A PC that can't open
that frame answers nothing and closes. The phone then shows "This PC forgot this phone. Pair
again."

### Frames (after the handshake)

```
u32 BE  length of the sealed body (ciphertext + 16-byte tag), at most 1 MiB + 16
…       sealed body
```

The plaintext's first byte is the frame kind:

- `1` = one JSON message (UTF-8), always an object with a string `t`.
- `2` = file data: `u32 BE transfer id`, then up to 256 KiB of bytes.

Requests that expect an answer carry `"rid": <u32>`. The answer has `"t":"re"`, the same `rid`,
and either `"ok":true,…fields` or `"ok":false,"error":"…"`. The PC waits up to 15 s, or 60 s for
file listings. Either side sends `{"t":"ping"}` after 10 s of silence and closes after 30 s with
nothing received. The phone reconnects with backoff (1, 2, 5, 10, 30 s) while the PC is on the
same Wi-Fi and the link is switched on.

### Messages

Phone → PC, unprompted:

| t | fields |
| --- | --- |
| `hello` | `name, model, android (sdk int), app (versionName), caps: ["sms","calls","contacts","notifications","files","photos","clipboard","mirror"]` (the ones whose permission is granted) |
| `status` | `battery (0-100), charging, signal (0-4 or null), network ("LTE"…, or null), carrier, wifi (ssid or null)`. Sent on change, at most every 5 s |
| `sms.new` | `msg: Msg` (a received or sent SMS appeared) |
| `notif.posted` | `n: Notif` |
| `notif.removed` | `key` |
| `call.state` | `state: "ringing"|"dialing"|"active"|"held"|"ended", number, name, at` (from the phone's TelephonyCallback; the PC uses it for names and when Bluetooth isn't set up) |
| `file.offer` | `xfer, name, size, mime` (the phone's share sheet → "Zazabor Link", or the app's Send button). The PC answers `{"t":"file.accept","xfer"}` or `{"t":"file.reject","xfer"}` and then reads `2`-frames for that `xfer`, ending with `{"t":"file.end","xfer","sha256":"<hex>"}` |
| `clip` | `text` (only when the user turned on clipboard sharing on both sides) |

PC → phone requests (`rid`, answer fields after `→`):

| t | fields | → answer |
| --- | --- | --- |
| `sms.threads` | `limit` | `threads: Thread[]` |
| `sms.thread` | `threadId, before (ms or null), limit` | `msgs: Msg[]` (newest last) |
| `sms.send` | `to: [number], body` | `{}` once SmsManager accepted it; the sent row arrives later as `sms.new` |
| `sms.read` | `threadId` | `{}` (mark read; only works when the app is the default SMS app, otherwise it still answers ok) |
| `calls.list` | `limit` | `calls: Call[]` |
| `contacts.list` | — | `contacts: Contact[]` |
| `contact.photo` | `id` | `jpeg: base64 or null` (96 px) |
| `notif.list` | — | `notifs: Notif[]` |
| `notif.dismiss` | `key` | `{}` |
| `notif.action` | `key, action (index), text (for reply actions, else null)` | `{}` |
| `photos.list` | `offset, limit` | `photos: Photo[]` (MediaStore images and videos, newest first, with a 256 px JPEG thumbnail in base64) |
| `files.list` | `path` ("" = the storage roots) | `entries: Entry[]` |
| `files.get` | `path, xfer` | `{size}`, then `2`-frames for `xfer`, then `{"t":"file.end","xfer","sha256"}` |
| `files.put` | `dir, name, size, xfer` | `{path}` (the final path, renamed " (2)" if taken). The PC then sends `2`-frames and `file.end` |
| `files.delete` | `path` | `{}` |
| `xfer.cancel` | `xfer` | (no answer; either side sends it, and both drop the partial file) |
| `call.dial` / `call.answer` / `call.end` | `number` (dial only) | `{}` (without Bluetooth: TelecomManager; the audio stays on the phone) |
| `ring` | — | `{}` (plays the alarm sound at full volume until the phone is touched, or for 30 s) |
| `mirror.start` | — | `{}` once the phone asked the user for screen capture. Mirroring then runs through ZMIR to the Cast receiver |
| `clip` | `text` | (no answer) |

Types (JSON, times in Unix ms):

```
Thread  { threadId, addresses:[number], name|null, snippet, at, unread, count }
Msg     { id, threadId, address, body, at, out (bool), status ("sent"|"pending"|"failed"|"received"), mms (bool) }
Call    { id, number, name|null, at, duration (s), kind ("in"|"out"|"missed"|"rejected"|"blocked"|"voicemail") }
Contact { id, name, numbers:[{number,label}], starred, hasPhoto }
Notif   { key, app (package), appName, title, text, at, icon (base64 png 48px or null),
          actions:[{title, reply (bool)}], clearable }
Photo   { id, uri, name, at, size, mime, width, height, video (bool), duration|null, thumb (base64 jpeg) }
Entry   { name, path, dir (bool), size, at, mime|null }
```

Transfer ids are chosen by whichever side starts the transfer: the PC uses even numbers and the
phone uses odd. Files from the phone go to the user's Downloads folder, under
`~/Downloads/Zazabor Link/` (setting `phone.downloadDir`). Files from the PC go to the phone's
`Download/Zazabor/`, or to the folder open in the file browser when dropped there.

## 2. Bluetooth calls (HFP 1.7 hands-free, Zazabor is the HF)

`src-tauri/src/phonelink/hfp/`. Zazabor registers the Hands-Free profile itself, over D-Bus
through the `gio` crate's GDBus. It needs no new D-Bus crate.

- `org.bluez.ProfileManager1.RegisterProfile(path, "0000111e-0000-1000-8000-00805f9b34fb",
  {Name:"Zazabor Hands-Free", Version:0x0107, Features:<SDP HF features>, AutoConnect:true})`, exporting
  `org.bluez.Profile1` (`NewConnection(device, fd, props)`, `RequestDisconnection`, `Release`).
- **PipeWire already registers 0x111E** (its `hfp_hf` role). When the user switches calls on,
  Zazabor writes `~/.config/wireplumber/bluetooth.lua.d/51-zazabor-calls.lua`. That file sets
  `bluez5.roles` to the default list minus `hsp_hs` and `hfp_hf`
  (`[ a2dp_sink a2dp_source bap_sink bap_source hsp_ag hfp_ag ]`). Zazabor then runs
  `systemctl --user restart wireplumber` and registers its own profile. Switching calls off removes
  the file and restarts WirePlumber again. Headsets still work: the PC keeps the `hfp_ag` and
  `hsp_ag` roles it uses with them. Write only that one file, and check for WirePlumber 0.5's
  `wireplumber.conf.d` layout as well.
- **Service level connection** (on the RFCOMM fd): `AT+BRSF=<HF features>` (CLI, call waiting,
  remote volume, enhanced call status, enhanced call control; no codec negotiation, so CVSD) →
  `AT+CIND=?` (map indicator names to indexes) → `AT+CIND?` → `AT+CMER=3,0,0,1` →
  `AT+CHLD=?` when the phone supports three-way calling. Then `AT+CLIP=1`, `AT+CCWA=1`,
  `AT+CMEE=1`, `AT+COPS=3,0` + `AT+COPS?` (carrier), and `AT+CLCC` after each change.
  Unsolicited messages: `+CIEV` (call, callsetup, callheld, service, signal, roam, battchg), `RING`,
  `+CLIP`, `+CCWA`, `+VGS`, `+VGM`, `+BSIR`.
- **Commands**: `ATD<number>;`, `ATA`, `AT+CHUP`, `AT+VTS=<d>`, `AT+CHLD=0|1|2`, `AT+BLDN`,
  `AT+VGS=<0-15>`, `AT+NREC=0`.
- **Audio**: a SCO socket (`BTPROTO_SCO`, `BT_VOICE` = 0x0060 CVSD). It listens on the adapter for
  the phone's audio connection, and it can also connect to the phone itself (audio "to the PC"
  during a call). It carries 16-bit LE 8 kHz mono at the socket's MTU. Audio goes through GStreamer:
  appsrc → audioconvert/audioresample → autoaudiosink (the caller's voice), and autoaudiosrc →
  8 kHz S16LE mono → appsink (the mic). Use webrtcdsp/webrtcechoprobe echo cancelling when the
  plugin exists. "Use phone" closes SCO, so the audio moves back to the handset.
- Several phones can be paired. The phone connected over HFP is the one that calls go through.
  If the phone is also linked over Wi-Fi, the PC matches them by name. Otherwise the PC uses the
  phone whose `hello` said the same Bluetooth name.

## 3. Desktop commands and events

Rust, `src-tauri/src/phonelink/` (module name `phonelink`). Commands go into `lib.rs`
`generate_handler!`. The page wraps them in `src/modules/phone/api.ts`. Errors are user-readable
`String`s.

Link (`phonelink/mod.rs`, `link.rs`, `store.rs`, `xfer.rs`):

| command | args | returns |
| --- | --- | --- |
| `phone_state` | — | `PhoneState` |
| `phone_link_enable` | `on: bool` | `PhoneState` (starts or stops the listener and the mDNS advert, and sets config `phone.enabled`) |
| `phone_pair_answer` | `phoneId, accept: bool` | — |
| `phone_forget` | `phoneId` | — |
| `phone_rename` | `phoneId, name` | — |
| `phone_threads` | `phoneId` | `Thread[]` (cached; refreshed from the phone when connected) |
| `phone_thread` | `phoneId, threadId, before?: number` | `Msg[]` |
| `phone_sms_send` | `phoneId, to: string[], body` | — |
| `phone_calls` | `phoneId` | `Call[]` |
| `phone_contacts` | `phoneId` | `Contact[]` |
| `phone_contact_photo` | `phoneId, id` | `string | null` (data: URL) |
| `phone_notifs` | `phoneId` | `Notif[]` |
| `phone_notif_dismiss` | `phoneId, key` | — |
| `phone_notif_action` | `phoneId, key, action, text?` | — |
| `phone_photos` | `phoneId, offset, limit` | `Photo[]` (thumb becomes a `data:` URL) |
| `phone_files` | `phoneId, path` | `Entry[]` |
| `phone_download` | `phoneId, paths: string[], dest?: string` | `number[]` transfer ids (dest defaults to the download folder) |
| `phone_upload` | `phoneId, paths: string[], dir?: string` | `number[]` transfer ids (local files or folders; folders recurse) |
| `phone_file_delete` | `phoneId, path` | — |
| `phone_transfers` | — | `Transfer[]` |
| `phone_transfer_cancel` | `id` | — |
| `phone_ring` | `phoneId` | — |
| `phone_mirror` | `phoneId` | — (also turns on the Cast receiver when it is off, via the cast module's public API) |
| `phone_clip_share` | `phoneId, on: bool` | — |

Bluetooth calls (`phonelink/hfp/`):

| command | args | returns |
| --- | --- | --- |
| `phone_bt_state` | — | `BtState` |
| `phone_bt_enable` | `on: bool` | `BtState` (writes or removes the WirePlumber drop-in, restarts WirePlumber, registers or unregisters the profile, sets config `phone.calls`) |
| `phone_bt_connect` | `address` | — (connects HFP to a paired phone) |
| `phone_bt_settings` | — | — (opens the system's Bluetooth settings so the user can pair a phone) |
| `phone_call_dial` | `number` | — |
| `phone_call_answer` / `phone_call_hangup` / `phone_call_decline` | — | — |
| `phone_call_dtmf` | `digit` | — |
| `phone_call_hold` | `action: 0|1|2` | — (AT+CHLD) |
| `phone_call_audio` | `onPc: bool` | — |
| `phone_call_mute` | `on: bool` | — (mutes the PC mic going to SCO) |
| `phone_call_volume` | `level: 0-15` | — |

Types:

```
PhoneState { enabled, port|null, pcName, phones: Phone[], pairing: {phoneId,name,code}|null, clip: bool }
Phone      { phoneId, name, model, connected, lastSeen, battery|null, charging, signal|null,
             network|null, carrier|null, caps: string[], unreadSms, notifCount }
Transfer   { id, phoneId, name, size, done (bytes), dir ("in"|"out"), state ("queued"|"running"|"done"|"failed"|"cancelled"), path|null, error|null }
BtState    { enabled, available (adapter present & powered), dropIn (bool), devices: BtPhone[], calls: Call[] (live), audioOnPc, muted, volume }
BtPhone    { address, name, paired, connected (HFP), battery|null, signal|null, carrier|null, phoneId|null }
LiveCall   { idx, number, name|null, dir ("in"|"out"), state ("active"|"held"|"dialing"|"alerting"|"incoming"|"waiting"), since|null }
```

(`BtState.calls` holds `LiveCall`s from `AT+CLCC`.)

Events emitted to every window (the main window shows the call bar and incoming-call card):

- `phone-changed` → `PhoneState` (connect, disconnect, status, pairing)
- `phone-pair` → `{phoneId, name, code}` (the main window shows the comparison dialog even
  when Phone isn't open)
- `phone-sms` → `{phoneId, msg}`
- `phone-notif` → `{phoneId, n}` / `phone-notif-removed` → `{phoneId, key}`
- `phone-transfer` → `Transfer` (at most every 250 ms per transfer, and always when it ends)
- `phone-bt` → `BtState` (any call or connection change)
- `phone-ring` → `LiveCall` (an incoming call; the page shows the incoming-call card with Answer and Decline)

Desktop notifications go through `desktop_notify.rs`, for new texts and mirrored phone
notifications, when the window isn't focused on that conversation. The config keys `phone.notify`
(texts) and `phone.mirrorNotifs` (phone notifications) control them.

Cache: `phone.db` (SQLite) in the app data dir holds pairings (`phoneId, name, model, linkKey,
pairedAt, lastSeen`), the PC id, and the last threads, messages, calls and contacts per phone.
Phone shows them while the phone is away, marked "Last synced …".

## 4. The Phone section (page)

`src/modules/phone/`, ModuleId `"phone"`, rail icon `phone`. It follows the other modules: glass
sidebar, the Figma/Liquid Glass style, ui/dom `h()`.

- **No phone yet:** a welcome screen with "Install Zazabor Link on your Android phone" (APK
  location/QR to the GitHub release), "Turn on Phone Link", and the waiting/pairing state with the
  six-digit comparison.
- **Sidebar:** a phone card with name, model, battery, signal, carrier and a Wi-Fi/Bluetooth link
  dot, plus Ring, Mirror screen and a ⋯ menu (rename, forget). Below it are the tabs Messages,
  Calls, Photos, Files and Notifications.
- **Messages:** the thread list with search, a conversation with bubbles, a compose box
  (Enter sends, Shift+Enter makes a new line), and a "New message" contact picker.
- **Calls:** history, a dialer keypad, and contacts with search. A call button starts the call
  over Bluetooth, or over the app when Bluetooth calls are off (then the audio stays on the
  phone). There is a "Set up calls through this PC" card when Bluetooth isn't set up.
- **Call bar** (any section, main window): an incoming card (caller name/number, Answer, Decline)
  and an in-call bar (timer, mute, keypad, hold, audio "PC/phone", end).
- **Photos:** a grid of recent photos. Click opens a preview. Drag a photo out, or Save, to
  download it.
- **Files:** a phone file browser with breadcrumbs. Drop files from the desktop (Tauri drag-drop
  events) or from Zazabor Files onto it to upload. Download, delete, and a transfers tray with
  progress and cancel.
- **Drop anywhere:** dropping files on the Phone section outside Files sends them to the phone's
  `Download/Zazabor/`.
- **Notifications:** a list with app icon, reply box for reply actions, and dismiss.
- **Settings → Phone:** link on/off, PC name, download folder, notify on new texts, mirror phone
  notifications, clipboard sharing, Bluetooth calls on/off (with what it changes), and paired phones.

Config (`src/config.ts`): `phone: { enabled: false, calls: false, downloadDir: "", notify: true,
mirrorNotifs: true, clip: false, active: "" }`.

## 5. Zazabor Link (Android, `mobile-cast/`)

Additions to the Cast app. Leave `MirrorService` and ZMIR alone. `mirror.start` opens the existing
mirroring flow (it asks for MediaProjection consent).

- `LinkService`: a foreground service of type `connectedDevice` with a quiet ongoing
  notification ("Linked to ‹PC›"). It owns the `ZLNK` socket, reconnects, and starts on boot and
  on Wi-Fi connect while a PC is paired.
- `Link.kt` (handshake, crypto, frames), `Pairing` UI (code comparison), and stores (`Sms.kt`,
  `CallLog.kt`, `Contacts.kt`, `Photos.kt`, `PhoneFiles.kt`). Content observers on SMS push
  `sms.new`.
- `NotifListener` (NotificationListenerService) handles `notif.*`. Replies use the action's
  RemoteInput.
- Permissions are asked one at a time from a "Phone Link" setup list on the main screen:
  READ_SMS, SEND_SMS, RECEIVE_SMS, READ_CALL_LOG, READ_CONTACTS, READ_PHONE_STATE, CALL_PHONE,
  ANSWER_PHONE_CALLS, notification access, all-files access (MANAGE_EXTERNAL_STORAGE) for the file
  browser, and READ_MEDIA_IMAGES/VIDEO. Each one is optional. The app sends `caps` for the ones
  it was given.
- A share target (`ACTION_SEND` / `SEND_MULTIPLE`, any type) "Send to PC" offers files over the link.
- The main screen keeps "Mirror to a PC" and gains a "Phone Link" card: paired PC, status,
  pair/forget, and the permission list.

## 6. Test vectors (both sides must reproduce them)

With `z = 00 01 02 … 1f` (32 bytes), `phoneNonce = a0 a1 … af`, `pcNonce = c0 c1 … cf`:

- `linkKey = 6e14f476f50e5be385a1cf6b0878ce8d9afd9bf12530dc6d5d5007cba3f40e7f`
- `code = 910268` (shown as `910 268`)
- session phone→PC key `fe57135bfb34b1a6bca23d6af4898fc4700898352d76f91b830b8cfbbc86bd33`
- session PC→phone key `693b278d4bfe7d55f4f02a017d9f7d2053a42e25bdc02eba072d0b9d731a29e3`
- The phone's first two frames, both carrying the plaintext `01 7b2274223a2270696e67227d` (kind 1 +
  `{"t":"ping"}`), seal to these values (ciphertext ‖ tag, without the length prefix):
  counter 0: `7dd06ba0d697b88ef9c9f1432cd32fcc2e09f5579ab1dc3406712b94d5`;
  counter 1: `770de953a6cc1b95c88cd9914e8ec5a99b8890d52c0b62237318cfa09b`
- `phoneId` for mirrorSecret `00112233445566778899aabbccddeeff` = `5947d7c33d783f94b3b4c1a96ebc8991`
