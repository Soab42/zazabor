import type { Account, Address, Overview } from "../mail/api";
import type { Events, MeetMock, MeetState, Meeting, MeetingInput, Recording } from "./api";

/**
 * A pretend backend for working on the Meet section without one (dev builds only; see api.ts).
 * Modes: "1" the tunnel on and some meetings, "bare" nothing yet and the outside link off.
 * `window.__meetMock.emit(event, payload)` fires an event, e.g. a knock.
 */
export function createMock(mode: string): MeetMock {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
    for (const fn of listeners.get(event) ?? []) (fn as (p: Events[K]) => void)(structuredClone(payload));
  };
  (window as unknown as { __meetMock: unknown }).__meetMock = { emit };
  const now = Date.now();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const at = (daysFromNow: number, h: number, m = 0) => {
    const d = new Date(now + daysFromNow * day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const person = (name: string, sent: number | null = null, error: string | null = null) => ({ email: `${name.split(" ")[0].toLowerCase()}@example.com`, name, sentAt: sent, error });

  const state: MeetState = {
    port: 47230,
    tunnel: mode === "bare" ? { state: "off", url: null, error: null } : { state: "on", url: "https://quiet-harbor-glass-7f3.trycloudflare.com", error: null },
    browser: "Google Chrome", recordingsDir: "/home/soab/Videos/Zazabor Meetings",
    stun: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"], turn: null,
  };

  const base = { kind: "meeting" as const, autoRecord: true, lobby: true, hostIn: false, people: 0, waiting: 0, recording: false, live: false };
  let meetings: Meeting[] = mode === "bare" ? [] : [
    { ...base, id: "a1b2c3d4e5f60001", code: "kqmnwjt7xa", title: "Design review", startsAt: now - 12 * min, minutes: 45, createdAt: now - 2 * day, live: true, hostIn: true, people: 4, waiting: 2, recording: true, invitees: [person("Ayesha Rahman", now - 2 * day), person("Tanvir Hasan", now - 2 * day), person("Nadia Islam", now - 2 * day)] },
    { ...base, id: "a1b2c3d4e5f60002", code: "p4rd8cwh3m", title: "Weekly sync with the team", startsAt: now + 3 * hour, minutes: 30, createdAt: now - 5 * day, invitees: [person("Sadia Karim", now - 5 * day), person("Imran Chowdhury", null, "Mailbox full (552)"), person("Rafiq Ahmed", now - 5 * day)] },
    { ...base, id: "a1b2c3d4e5f60003", code: "z9h2vbnq5c", title: "Call with Mom", kind: "call", startsAt: at(1, 20, 0), minutes: 0, autoRecord: false, lobby: false, createdAt: now - day, invitees: [] },
    { ...base, id: "a1b2c3d4e5f60004", code: "d7fxe3gr2k", title: "Quarterly planning", startsAt: at(-2, 11, 0), minutes: 60, createdAt: now - 6 * day, invitees: [person("Ayesha Rahman", now - 6 * day), person("Sadia Karim", now - 6 * day)] },
    { ...base, id: "a1b2c3d4e5f60005", code: "m3tq6yaw8j", title: "Meeting", startsAt: null, minutes: 0, createdAt: now - 4 * day, invitees: [] },
    { ...base, id: "a1b2c3d4e5f60006", code: "w5nc4kpb9s", title: "Interview: front-end role", startsAt: at(-9, 15, 0), minutes: 45, createdAt: now - 11 * day, invitees: [person("Nadia Islam", now - 11 * day)] },
  ];
  const recordings: Recording[] = mode === "bare" ? [] : [
    { id: "r1", meetingId: "a1b2c3d4e5f60001", title: "Design review", path: "/home/soab/Videos/Zazabor Meetings/Design review 2026-11-21 10.00.webm", startedAt: now - 11 * min, endedAt: null, bytes: 38_400_000 },
    { id: "r2", meetingId: "a1b2c3d4e5f60004", title: "Quarterly planning", path: "/home/soab/Videos/Zazabor Meetings/Quarterly planning 2026-11-19 11.00.webm", startedAt: at(-2, 11, 0), endedAt: at(-2, 11, 0) + 58 * min, bytes: 612_000_000 },
    { id: "r3", meetingId: "a1b2c3d4e5f60006", title: "Interview: front-end role", path: "/home/soab/Videos/Zazabor Meetings/Interview front-end role 2026-11-12 15.00.webm", startedAt: at(-9, 15, 0), endedAt: at(-9, 15, 0) + 41 * min, bytes: 402_000_000 },
    { id: "r4", meetingId: "a1b2c3d4e5f60005", title: "Meeting", path: "/home/soab/Videos/Zazabor Meetings/Meeting 2026-11-17 09.20.webm", startedAt: at(-4, 9, 20), endedAt: at(-4, 9, 20) + 6 * min, bytes: 41_500_000 },
  ];

  const account = (id: string, email: string, name: string): Account => ({ id, email, name, color: "#0a84ff", username: email, imap: { host: "imap.example.com", port: 993, security: "ssl" }, smtp: { host: "smtp.example.com", port: 465, security: "ssl" } } as unknown as Account);
  const accounts = mode === "nomail" ? [] : [account("acc1", "me@example.com", "Soab"), account("acc2", "work@example.org", "Soab (work)")];
  const contacts: Address[] = [
    ["Ayesha Rahman", "ayesha@example.com"], ["Tanvir Hasan", "tanvir@example.com"], ["Nadia Islam", "nadia@example.com"],
    ["Sadia Karim", "sadia@example.com"], ["Imran Chowdhury", "imran@example.com"], ["Rafiq Ahmed", "rafiq@example.com"],
  ].map(([name, addr]) => ({ name, addr }));

  let counter = 10;
  const make = (input: MeetingInput, id?: string): Meeting => {
    const old = meetings.find((m) => m.id === id);
    return {
      ...base, ...old, ...input, id: id ?? `b1b2c3d4e5f6${String(++counter).padStart(4, "0")}`, code: old?.code ?? "x7k2m9qbn4", createdAt: old?.createdAt ?? Date.now(),
      invitees: input.invitees.map((i) => old?.invitees.find((o) => o.email === i.email) ?? { ...i, sentAt: null, error: null }),
    };
  };
  const find = (id: unknown) => {
    const m = meetings.find((x) => x.id === id);
    if (!m) throw new Error("No such meeting");
    return m;
  };
  const changed = () => setTimeout(() => emit("meet-changed", null), 0);
  const wait = <T>(value: T, ms = 120) => new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

  return {
    listen(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn as (p: never) => void);
      listeners.set(event, set);
      return () => set.delete(fn as (p: never) => void);
    },
    async invoke(cmd, a) {
      switch (cmd) {
        case "meet_state": return wait(state);
        case "meet_list": return wait(meetings);
        case "meet_create": {
          const m = make(a as unknown as MeetingInput);
          meetings = [m, ...meetings];
          changed();
          return wait(m);
        }
        case "meet_update": {
          const m = make(a as unknown as MeetingInput, a.id as string);
          meetings = meetings.map((x) => (x.id === m.id ? m : x));
          changed();
          return wait(m);
        }
        case "meet_delete": {
          if (find(a.id).live) throw new Error("It's live right now. End it first.");
          meetings = meetings.filter((m) => m.id !== a.id);
          changed();
          return wait(undefined);
        }
        case "meet_join_url": {
          if (state.tunnel.state !== "on") {
            state.tunnel = { state: "on", url: "https://quiet-harbor-glass-7f3.trycloudflare.com", error: null };
            changed();
          }
          return wait(`${state.tunnel.url}/m/${find(a.id).code}`, 400);
        }
        case "meet_open": {
          const m = find(a.id);
          m.live = m.hostIn = true;
          m.people = Math.max(m.people, 1);
          m.recording = m.autoRecord;
          changed();
          return wait(undefined);
        }
        case "meet_invite": {
          const m = find(a.id);
          const sent = Date.now();
          m.invitees = m.invitees.map((i) => (i.email.startsWith("imran") ? { ...i, error: "Mailbox full (552)" } : { ...i, sentAt: sent, error: null }));
          changed();
          return wait(m.invitees, 500);
        }
        case "meet_end": {
          const m = find(a.id);
          Object.assign(m, { live: false, hostIn: false, people: 0, waiting: 0, recording: false });
          changed();
          return wait(undefined);
        }
        case "meet_recordings": return wait(recordings);
        case "meet_recording_delete": {
          recordings.splice(recordings.findIndex((r) => r.id === a.id), 1);
          changed();
          return wait(undefined);
        }
        case "meet_tunnel":
          state.tunnel = a.on ? { state: "on", url: "https://quiet-harbor-glass-7f3.trycloudflare.com", error: null } : { state: "off", url: null, error: null };
          changed();
          return wait(state, 500);
        case "meet_settings":
          state.stun = a.stun as string[];
          state.turn = a.turn as MeetState["turn"];
          return wait(state);
        case "mail_overview": return wait({ accounts, drafts: 0, colors: [] } satisfies Overview);
        case "mail_contacts": {
          const p = String(a.prefix ?? "").toLowerCase();
          return wait(contacts.filter((c) => c.name.toLowerCase().includes(p) || c.addr.includes(p)), 60);
        }
        default: throw new Error(`The Meet mock has no ${cmd}`);
      }
    },
  };
}
