import type { BtState, Call, Contact, Entry, Events, LiveCall, Msg, Notif, Phone, PhoneMock, PhoneState, Photo, Thread, Transfer } from "./api";

/**
 * A pretend phone for working on the Phone section without one (dev builds only; see api.ts).
 * Modes: "1" a linked phone with Bluetooth calls, "bare" nothing paired and the link off, "pair" a
 * phone asking to pair, "call" an incoming call, "incall" a call in progress, "away" the phone
 * out of reach (cached content).
 */
export function createMock(mode: string): PhoneMock {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
    for (const fn of listeners.get(event) ?? []) (fn as (p: Events[K]) => void)(structuredClone(payload));
  };
  const now = Date.now();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;

  const phone: Phone = {
    phoneId: "5947d7c33d783f94b3b4c1a96ebc8991", name: "Pixel 7", model: "Google Pixel 7", connected: mode !== "away", lastSeen: now - (mode === "away" ? 3 * hour : 0),
    battery: 76, charging: false, signal: 3, network: "LTE", carrier: "Grameenphone", caps: ["sms", "calls", "contacts", "notifications", "files", "photos", "clipboard", "mirror"],
    unreadSms: 2, notifCount: 5,
  };
  const state: PhoneState = {
    enabled: mode !== "bare", port: mode === "bare" ? null : 47213, pcName: "Zazabor on soab-desk",
    phones: mode === "bare" || mode === "pair" ? [] : [phone], pairing: null, clip: false,
  };

  const contacts: Contact[] = [
    ["c1", "Ayesha Rahman", "+880 1711 234567", true, true],
    ["c2", "Mom", "+880 1819 000111", true, false],
    ["c3", "Tanvir Hasan", "+880 1555 987654", false, false],
    ["c4", "Nadia Islam", "+880 1912 445566", false, true],
    ["c5", "Office Reception", "+880 2 9112233", false, false],
    ["c6", "Rafiq (Plumber)", "+880 1677 223344", false, false],
    ["c7", "Sadia Karim", "+880 1733 778899", true, false],
    ["c8", "Imran Chowdhury", "+880 1300 112233", false, false],
  ].map(([id, name, number, starred, hasPhoto]) => ({ id: id as string, name: name as string, numbers: [{ number: number as string, label: "Mobile" }], starred: starred as boolean, hasPhoto: hasPhoto as boolean }));

  const threads: Thread[] = [
    { threadId: 1, addresses: ["+880 1711 234567"], name: "Ayesha Rahman", snippet: "Sounds good, see you at 7 then!", at: now - 4 * min, unread: 2, count: 14 },
    { threadId: 2, addresses: ["+880 1819 000111"], name: "Mom", snippet: "Did you eat?", at: now - 2 * hour, unread: 0, count: 230 },
    { threadId: 3, addresses: ["16216"], name: null, snippet: "Your OTP is 482913. Do not share it with anyone.", at: now - 5 * hour, unread: 0, count: 31 },
    { threadId: 4, addresses: ["+880 1555 987654"], name: "Tanvir Hasan", snippet: "Sent the files to your email", at: now - day - 3 * hour, unread: 0, count: 8 },
    { threadId: 5, addresses: ["GP"], name: null, snippet: "Recharge 299 Tk and get 30 GB for 30 days. Dial *121*3#", at: now - 2 * day, unread: 0, count: 120 },
    { threadId: 6, addresses: ["+880 1912 445566", "+880 1733 778899"], name: null, snippet: "Nadia: I'll bring the cake 🎂", at: now - 4 * day, unread: 0, count: 52 },
    { threadId: 7, addresses: ["+880 1677 223344"], name: "Rafiq (Plumber)", snippet: "Coming tomorrow morning", at: now - 12 * day, unread: 0, count: 3 },
  ];
  let nextMsg = 1000;
  const conversation = (threadId: number, address: string, lines: [boolean, string, number][]): Msg[] =>
    lines.map(([out, body, ago]) => ({ id: nextMsg++, threadId, address, body, at: now - ago, out, status: out ? "sent" : "received", mms: false }));
  const messages = new Map<number, Msg[]>([
    [1, conversation(1, "+880 1711 234567", [
      [false, "Hey! Are we still on for dinner tonight?", 3 * hour],
      [true, "Yes! Where do you want to go?", 3 * hour - 5 * min],
      [false, "How about the new place on Road 11? They have great kacchi", 2 * hour],
      [true, "Perfect. 7 pm?", 40 * min],
      [true, "I can pick you up on the way if you like, I'll be coming from the office anyway.", 39 * min],
      [false, "That would be lovely", 5 * min],
      [false, "Sounds good, see you at 7 then!", 4 * min],
    ])],
    [2, conversation(2, "+880 1819 000111", [[false, "Call me when you're free", 3 * hour], [true, "In a meeting, will call at 5", 2.5 * hour], [false, "Did you eat?", 2 * hour]])],
    [3, conversation(3, "16216", [[false, "Your OTP is 482913. Do not share it with anyone.", 5 * hour]])],
  ]);

  const calls: Call[] = [
    { id: 1, number: "+880 1711 234567", name: "Ayesha Rahman", at: now - 30 * min, duration: 324, kind: "in" },
    { id: 2, number: "+880 1819 000111", name: "Mom", at: now - 3 * hour, duration: 0, kind: "missed" },
    { id: 3, number: "+880 1555 987654", name: "Tanvir Hasan", at: now - 5 * hour, duration: 1260, kind: "out" },
    { id: 4, number: "+880 9638 000000", name: null, at: now - day, duration: 0, kind: "rejected" },
    { id: 5, number: "+880 1912 445566", name: "Nadia Islam", at: now - day - 2 * hour, duration: 95, kind: "out" },
    { id: 6, number: "+880 1300 112233", name: "Imran Chowdhury", at: now - 3 * day, duration: 42, kind: "in" },
    { id: 7, number: "+880 1819 000111", name: "Mom", at: now - 4 * day, duration: 1820, kind: "in" },
  ];

  // (The phone sends a base64 PNG; a data: URL works too, and is what the mock can make.)
  const pngIcon = (hue: number, letter: string) => "data:image/svg+xml;base64," +
    btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="12" fill="hsl(${hue},70%,50%)"/><text x="24" y="32" font-family="sans-serif" font-size="22" font-weight="700" fill="white" text-anchor="middle">${letter}</text></svg>`);
  const notifs: Notif[] = [
    { key: "n1", app: "com.whatsapp", appName: "WhatsApp", title: "Ayesha Rahman", text: "Can you send me the photos from yesterday?", at: now - 2 * min, icon: pngIcon(142, "W"), actions: [{ title: "Reply", reply: true }, { title: "Mark as read", reply: false }], clearable: true },
    { key: "n2", app: "com.google.android.gm", appName: "Gmail", title: "Your flight to Chattogram is confirmed", text: "US-Bangla Airlines · BS 141 · Sat 22 Nov, 08:15", at: now - 25 * min, icon: pngIcon(4, "M"), actions: [{ title: "Archive", reply: false }, { title: "Reply", reply: true }], clearable: true },
    { key: "n3", app: "com.bkash.customerapp", appName: "bKash", title: "Cash In successful", text: "You have received Tk 5,000 from 01711234567. Balance Tk 12,480.", at: now - 2 * hour, icon: pngIcon(330, "b"), actions: [], clearable: true },
    { key: "n4", app: "com.spotify.music", appName: "Spotify", title: "Now playing", text: "Coke Studio Bangla · Nasek Nasek", at: now - 3 * hour, icon: pngIcon(141, "S"), actions: [{ title: "Pause", reply: false }, { title: "Next", reply: false }], clearable: false },
    { key: "n5", app: "com.google.android.calendar", appName: "Calendar", title: "Team stand-up", text: "10:00 – 10:15 · Google Meet", at: now - 5 * hour, icon: pngIcon(217, "31"), actions: [], clearable: true },
  ];

  const photoSvg = (hue: number, i: number) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},65%,32%)"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="${60 + (i * 37) % 140}" cy="${70 + (i * 23) % 90}" r="${22 + (i % 4) * 8}" fill="hsla(${(hue + 180) % 360},80%,85%,.55)"/><path d="M0 200 L80 140 L140 190 L200 130 L256 180 L256 256 L0 256Z" fill="hsla(${hue},40%,20%,.55)"/></svg>`)}`;
  const photos: Photo[] = Array.from({ length: 140 }, (_, i) => ({
    id: i + 1, uri: `content://media/external/images/media/${9000 - i}`, name: i % 9 === 4 ? `VID_20261114_${String(1000 + i)}.mp4` : `IMG_20261114_${String(1000 + i)}.jpg`,
    at: now - i * 7 * hour, size: 2_400_000 + i * 13_000, mime: i % 9 === 4 ? "video/mp4" : "image/jpeg", width: 4080, height: 3072,
    video: i % 9 === 4, duration: i % 9 === 4 ? 12 + i : null, thumb: photoSvg((i * 47) % 360, i),
  }));

  const tree: Record<string, Entry[]> = {
    "": [{ name: "Internal storage", path: "/storage/emulated/0", dir: true, size: 0, at: now, mime: null }, { name: "SD card", path: "/storage/1A2B-3C4D", dir: true, size: 0, at: now, mime: null }],
    "/storage/emulated/0": ["Alarms", "DCIM", "Documents", "Download", "Movies", "Music", "Pictures", "Recordings"].map((name, i) => ({ name, path: `/storage/emulated/0/${name}`, dir: true, size: 0, at: now - i * day, mime: null })),
    "/storage/emulated/0/Download": [
      { name: "Zazabor", path: "/storage/emulated/0/Download/Zazabor", dir: true, size: 0, at: now - hour, mime: null },
      { name: "Boarding pass.pdf", path: "/storage/emulated/0/Download/Boarding pass.pdf", dir: false, size: 184_220, at: now - 2 * hour, mime: "application/pdf" },
      { name: "Invoice-2026-11.xlsx", path: "/storage/emulated/0/Download/Invoice-2026-11.xlsx", dir: false, size: 48_120, at: now - 3 * day, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { name: "song.mp3", path: "/storage/emulated/0/Download/song.mp3", dir: false, size: 6_120_330, at: now - 9 * day, mime: "audio/mpeg" },
      { name: "wallpaper.png", path: "/storage/emulated/0/Download/wallpaper.png", dir: false, size: 3_400_100, at: now - 12 * day, mime: "image/png" },
      { name: "Holiday clip.mp4", path: "/storage/emulated/0/Download/Holiday clip.mp4", dir: false, size: 48_300_000, at: now - 4 * day, mime: "video/mp4" },
      { name: "Receipt scan with a very long file name that wraps onto lines.jpg", path: "/storage/emulated/0/Download/Receipt scan with a very long file name that wraps onto lines.jpg", dir: false, size: 920_000, at: now - 5 * day, mime: "image/jpeg" },
      { name: "notes.txt", path: "/storage/emulated/0/Download/notes.txt", dir: false, size: 2_100, at: now - 6 * day, mime: "text/plain" },
      { name: "backup.zip", path: "/storage/emulated/0/Download/backup.zip", dir: false, size: 12_400_000, at: now - 7 * day, mime: "application/zip" },
      { name: "app-release.apk", path: "/storage/emulated/0/Download/app-release.apk", dir: false, size: 24_800_000, at: now - 20 * day, mime: "application/vnd.android.package-archive" },
    ],
    "/storage/emulated/0/Download/Zazabor": [],
    "/storage/emulated/0/DCIM": [{ name: "Camera", path: "/storage/emulated/0/DCIM/Camera", dir: true, size: 0, at: now, mime: null }, { name: "Screenshots", path: "/storage/emulated/0/DCIM/Screenshots", dir: true, size: 0, at: now - day, mime: null }],
  };

  const bt: BtState = {
    enabled: mode !== "bare" && mode !== "nobt", available: true, dropIn: mode !== "bare",
    devices: [{ address: "AA:BB:CC:11:22:33", name: "Pixel 7", paired: true, connected: mode !== "bare" && mode !== "nobt", battery: 76, signal: 3, carrier: "Grameenphone", phoneId: phone.phoneId }],
    calls: [], audioOnPc: true, muted: false, volume: 10,
  };
  const incall: LiveCall = { idx: 1, number: "+880 1711 234567", name: "Ayesha Rahman", dir: "in", state: "active", since: now - 83_000 };
  if (mode === "incall") bt.calls = [incall];

  const transfers = new Map<number, Transfer>();
  let nextXfer = 2;
  const runTransfer = (name: string, size: number, dir: "in" | "out", path: string | null) => {
    const t: Transfer = { id: nextXfer += 2, phoneId: phone.phoneId, name, size, done: 0, dir, state: "running", path, error: null };
    transfers.set(t.id, t);
    emit("phone-transfer", t);
    const tick = window.setInterval(() => {
      if (t.state !== "running") return clearInterval(tick);
      t.done = Math.min(t.size, t.done + Math.max(1, Math.round(t.size / 12)));
      if (t.done >= t.size) {
        t.state = "done";
        clearInterval(tick);
      }
      emit("phone-transfer", t);
    }, 250);
    return t.id;
  };

  const changed = () => emit("phone-changed", state);
  const btChanged = () => emit("phone-bt", bt);
  const ring = (number: string, name: string | null) => {
    const live: LiveCall = { idx: 1, number, name, dir: "in", state: "incoming", since: null };
    bt.calls = [live];
    emit("phone-ring", live);
    btChanged();
  };

  if (mode === "pair") {
    window.setTimeout(() => {
      state.enabled = true;
      state.pairing = { phoneId: phone.phoneId, name: "Pixel 7", code: "910268" };
      changed();
      emit("phone-pair", state.pairing);
    }, 1200);
  }
  if (mode === "call") window.setTimeout(() => ring("+880 1711 234567", "Ayesha Rahman"), 1200);

  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    phone_state: () => state,
    phone_link_enable: (a) => {
      state.enabled = !!a.on;
      state.port = state.enabled ? 47213 : null;
      changed();
      return state;
    },
    phone_pair_answer: (a) => {
      if (a.accept && state.pairing) state.phones = [phone];
      state.pairing = null;
      changed();
    },
    phone_forget: (a) => {
      state.phones = state.phones.filter((p) => p.phoneId !== a.phoneId);
      changed();
    },
    phone_rename: (a) => {
      phone.name = String(a.name);
      changed();
    },
    phone_threads: () => threads,
    phone_thread: (a) => messages.get(Number(a.threadId)) ?? conversation(Number(a.threadId), threads.find((t) => t.threadId === a.threadId)?.addresses[0] ?? "", [[false, threads.find((t) => t.threadId === a.threadId)?.snippet ?? "", 3 * hour]]),
    phone_sms_send: (a) => {
      const to = (a.to as string[])[0];
      let thread = threads.find((t) => t.addresses.length === 1 && t.addresses[0] === to);
      if (!thread) {
        thread = { threadId: 100 + threads.length, addresses: [to], name: contacts.find((c) => c.numbers.some((n) => n.number === to))?.name ?? null, snippet: "", at: Date.now(), unread: 0, count: 0 };
        threads.unshift(thread);
      }
      const msg: Msg = { id: nextMsg++, threadId: thread.threadId, address: to, body: String(a.body), at: Date.now(), out: true, status: "sent", mms: false };
      const list = messages.get(thread.threadId) ?? [];
      list.push(msg);
      messages.set(thread.threadId, list);
      thread.snippet = msg.body;
      thread.at = msg.at;
      window.setTimeout(() => emit("phone-sms", { phoneId: phone.phoneId, msg }), 300);
    },
    phone_calls: () => calls,
    phone_contacts: () => contacts,
    phone_contact_photo: (a) => {
      const c = contacts.find((x) => x.id === a.id);
      if (!c?.hasPhoto) return null;
      return photoSvg((c.name.length * 53) % 360, c.name.length);
    },
    phone_wallpaper: () => photoSvg(212, 3),
    phone_notifs: () => notifs,
    phone_notif_dismiss: (a) => {
      const i = notifs.findIndex((n) => n.key === a.key);
      if (i >= 0) notifs.splice(i, 1);
      emit("phone-notif-removed", { phoneId: phone.phoneId, key: String(a.key) });
    },
    phone_notif_action: () => undefined,
    phone_photos: (a) => photos.slice(Number(a.offset), Number(a.offset) + Number(a.limit)),
    phone_photo_view: (a) => photos.find((p) => p.uri === a.uri)?.thumb ?? null,
    phone_files: (a) => {
      const list = tree[String(a.path)];
      if (!list) {
        if (String(a.path).startsWith("/storage")) return [];
        throw new Error("No such folder on the phone");
      }
      return list;
    },
    phone_download: (a) => (a.paths as string[]).map((p) => runTransfer(p.split("/").pop() ?? p, 3_000_000, "in", `/home/you/Downloads/Zazabor Link/${p.split("/").pop()}`)),
    phone_upload: (a) => (a.paths as string[]).map((p) => {
      const name = p.split("/").pop() ?? p;
      const dir = (a.dir as string | null) ?? "/storage/emulated/0/Download/Zazabor";
      (tree[dir] ??= []).push({ name, path: `${dir}/${name}`, dir: false, size: 1_500_000, at: Date.now(), mime: null });
      return runTransfer(name, 1_500_000, "out", `${dir}/${name}`);
    }),
    phone_file_delete: (a) => {
      for (const list of Object.values(tree)) {
        const i = list.findIndex((e) => e.path === a.path);
        if (i >= 0) list.splice(i, 1);
      }
    },
    phone_transfers: () => [...transfers.values()],
    phone_transfer_cancel: (a) => {
      const t = transfers.get(Number(a.id));
      if (t && t.state === "running") {
        t.state = "cancelled";
        emit("phone-transfer", t);
      }
    },
    phone_ring: () => undefined,
    phone_mirror: () => undefined,
    phone_clip_share: (a) => {
      state.clip = !!a.on;
      changed();
    },
    phone_bt_state: () => bt,
    phone_bt_enable: (a) => {
      bt.enabled = !!a.on;
      bt.dropIn = !!a.on;
      bt.devices[0].connected = !!a.on;
      btChanged();
      return bt;
    },
    phone_bt_connect: () => {
      bt.devices[0].connected = true;
      btChanged();
    },
    phone_bt_settings: () => undefined,
    phone_call_dial: (a) => {
      bt.calls = [{ idx: 1, number: String(a.number), name: contacts.find((c) => c.numbers.some((n) => n.number === a.number))?.name ?? null, dir: "out", state: "dialing", since: null }];
      btChanged();
      window.setTimeout(() => {
        if (bt.calls[0]?.state !== "dialing") return;
        bt.calls[0].state = "active";
        bt.calls[0].since = Date.now();
        btChanged();
      }, 2000);
    },
    phone_call_answer: () => {
      if (bt.calls[0]) {
        bt.calls[0].state = "active";
        bt.calls[0].since = Date.now();
      }
      btChanged();
    },
    phone_call_hangup: () => {
      bt.calls = [];
      btChanged();
    },
    phone_call_decline: () => {
      bt.calls = [];
      btChanged();
    },
    phone_call_dtmf: () => undefined,
    phone_call_hold: () => {
      const c = bt.calls[0];
      if (c) c.state = c.state === "held" ? "active" : "held";
      btChanged();
    },
    phone_call_audio: (a) => {
      bt.audioOnPc = !!a.onPc;
      btChanged();
    },
    phone_call_mute: (a) => {
      bt.muted = !!a.on;
      btChanged();
    },
    phone_call_volume: (a) => {
      bt.volume = Number(a.level);
      btChanged();
    },
  };

  // A text arrives now and then, so live updates can be seen.
  if (mode === "1") {
    window.setTimeout(() => {
      const msg: Msg = { id: nextMsg++, threadId: 1, address: "+880 1711 234567", body: "Also, bring the umbrella ☔", at: Date.now(), out: false, status: "received", mms: false };
      messages.get(1)?.push(msg);
      threads[0].snippet = msg.body;
      threads[0].at = msg.at;
      threads[0].unread += 1;
      emit("phone-sms", { phoneId: phone.phoneId, msg });
    }, 20_000);
  }

  return {
    async invoke(cmd, args) {
      await new Promise((r) => setTimeout(r, 60));
      const handler = handlers[cmd];
      if (!handler) throw new Error(`The mock has no ${cmd}`);
      return structuredClone(handler(args));
    },
    listen(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn as (payload: never) => void);
      return () => set!.delete(fn as (payload: never) => void);
    },
  };
}
