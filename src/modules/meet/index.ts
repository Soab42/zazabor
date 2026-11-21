import type { AppModule, ModuleFactory } from "../../shell/module";
import { isMainWindow } from "../../shell/windows";
import { dirname, formatBytes, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import "../files/ops/ops.css";
import { confirmSheet } from "../files/ops/sheets";
import { showToast } from "../files/ops/toast";
import type { Account } from "../mail/api";
import { clockText, codeText, dayText, durationText, errorText, isPast, meetApi, onMeet, whenText, type MeetState, type Meeting, type Recording } from "./api";
import { startMeetService } from "./global";
import "./meet.css";
import { callSheet, scheduleSheet } from "./sheets";

type View = "upcoming" | "past" | "recordings";

const VIEWS: { id: View; label: string; glyph: "calendar" | "clock" | "film" }[] = [
  { id: "upcoming", label: "Upcoming", glyph: "calendar" },
  { id: "past", label: "Past", glyph: "clock" },
  { id: "recordings", label: "Recordings", glyph: "film" },
];

/**
 * Meet: calls and meetings hosted by this PC (docs/plans/meet.md). A sidebar with Meet now, New
 * call and Schedule above Upcoming / Past / Recordings; the outside link's status over the list.
 * The meeting itself runs in the host's browser window, opened by the backend.
 */
export const createMeetModule: ModuleFactory = (shell): AppModule => {
  if (isMainWindow) startMeetService(shell);
  let view: View = "upcoming";
  let visible = false;
  let state: MeetState | null = null;
  let stateError: string | null = null;
  let loaded = false;
  let meetings: Meeting[] = [];
  let recordings: Recording[] = [];
  let tick = 0;
  let unlisten: Promise<() => void> | null = null;

  const toast = showToast;
  const fail = (what: string) => (err: unknown) => toast(`${what}: ${errorText(err)}`);

  // ---- data

  let loading = false;
  let again = false;
  async function reload() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      [state, meetings, recordings] = await Promise.all([meetApi.state(), meetApi.list(), meetApi.recordings()]);
      stateError = null;
    } catch (err) {
      stateError = errorText(err);
    }
    loaded = true;
    loading = false;
    draw();
    if (again) {
      again = false;
      void reload();
    }
  }

  const accounts = (): Promise<Account[]> => meetApi.mailAccounts().catch(() => []);
  const byTime = (m: Meeting) => m.startsAt ?? m.createdAt;
  const upcoming = () => meetings.filter((m) => m.live || !isPast(m)).sort((a, b) => Number(b.live) - Number(a.live) || byTime(a) - byTime(b));
  const past = () => meetings.filter((m) => !m.live && isPast(m)).sort((a, b) => byTime(b) - byTime(a));

  // ---- actions

  /** Puts the share link on the clipboard; if the system refuses (the window lost focus), offers a Copy button. */
  async function copyLink(m: Meeting, opening = false) {
    if (!opening && state?.tunnel.state !== "on") toast("Starting the outside link…", undefined, 20_000);
    let url: string;
    try {
      url = await meetApi.joinUrl(m.id);
    } catch (err) {
      return fail("Couldn't get the link")(err);
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast("The link is ready", { label: "Copy", run: () => void navigator.clipboard?.writeText(url).then(() => toast("Link copied"), () => toast(url)) }, 15_000);
    }
  }

  async function openMeeting(m: Meeting) {
    try {
      await meetApi.open(m.id);
    } catch (err) {
      fail("Couldn't open the meeting")(err);
    }
  }

  async function meetNow() {
    try {
      const m = await meetApi.create({ title: "Meeting", kind: "meeting", startsAt: null, minutes: 0, autoRecord: true, lobby: true, invitees: [] });
      void reload();
      await meetApi.open(m.id);
      await copyLink(m, true);
    } catch (err) {
      fail("Couldn't start the meeting")(err);
    }
  }

  async function newCall() {
    const answer = await callSheet(await accounts());
    if (!answer) return;
    const names = answer.invitees.map((i) => i.name || i.email);
    try {
      const m = await meetApi.create({
        title: names.length === 1 ? `Call with ${names[0]}` : names.length ? "Group call" : "Call", kind: "call", startsAt: null, minutes: 0, autoRecord: true, lobby: true, invitees: answer.invitees,
      });
      void reload();
      if (answer.invitees.length && answer.accountId) {
        await meetApi.invite(m.id, answer.accountId, "").catch((err) => toast(`Couldn't send the invitation: ${errorText(err)}`));
      }
      await meetApi.open(m.id);
      await copyLink(m, true);
    } catch (err) {
      fail("Couldn't start the call")(err);
    }
  }

  async function schedule(meeting?: Meeting) {
    const done = await scheduleSheet({ meeting, accounts: await accounts() });
    void reload();
    if (!done) return;
    view = "upcoming";
    draw();
    const bad = done.sent?.filter((i) => i.error).length ?? 0;
    if (done.error) toast(`Saved, but the invitations weren't sent: ${done.error}`);
    else if (bad) toast(`Saved. ${bad} invitation${bad === 1 ? "" : "s"} couldn't be sent.`);
    else if (done.sent) toast(`${meeting ? "Saved" : "Scheduled"}. ${done.sent.length === 1 ? "Invitation" : "Invitations"} sent.`);
    else toast(meeting ? "Saved" : "Scheduled", { label: "Copy link", run: () => void copyLink(done.meeting) });
  }

  /** Sends the invitations again from the one Mail account, or from the one the user picks. */
  async function resend(m: Meeting, anchor: HTMLElement) {
    if (!m.invitees.length) return toast("Add invitees first: Edit the meeting.");
    const list = await accounts();
    if (!list.length) return toast("There's no Mail account to send from. Add one in Mail.");
    const send = (account: Account) => {
      toast("Sending invitations…");
      void meetApi.invite(m.id, account.id, "").then((sent) => {
        void reload();
        const bad = sent.filter((i) => i.error).length;
        toast(bad ? `${bad} invitation${bad === 1 ? "" : "s"} couldn't be sent` : "Invitations sent");
      }, fail("Couldn't send the invitations"));
    };
    if (list.length === 1) return send(list[0]);
    const box = anchor.getBoundingClientRect();
    openMenu(box.left, box.bottom + 4, list.map((a): MenuItem => ({ label: `Send from ${a.email}`, icon: "send", action: () => send(a) })));
  }

  async function remove(m: Meeting) {
    if (!await confirmSheet({ title: "Delete this meeting?", message: `“${m.title}” will be removed. Its recordings stay in your recordings folder.`, confirmLabel: "Delete", destructive: true })) return;
    try {
      await meetApi.remove(m.id);
      void reload();
    } catch (err) {
      fail("Couldn't delete it")(err);
    }
  }

  async function end(m: Meeting) {
    if (!await confirmSheet({ title: "End the meeting for everyone?", message: `“${m.title}” will close for all ${m.people} ${m.people === 1 ? "person" : "people"} and the recording will stop.`, confirmLabel: "End for Everyone", destructive: true, icon: "stop" })) return;
    try {
      await meetApi.end(m.id);
      void reload();
    } catch (err) {
      fail("Couldn't end it")(err);
    }
  }

  async function deleteRecording(r: Recording) {
    if (!await confirmSheet({ title: "Delete this recording?", message: `“${r.title}” (${formatBytes(r.bytes)}) is deleted from the disk. This can't be undone.`, confirmLabel: "Delete", destructive: true })) return;
    try {
      await meetApi.recordingDelete(r.id);
      void reload();
    } catch (err) {
      fail("Couldn't delete it")(err);
    }
  }

  async function tunnelOn() {
    try {
      state = await meetApi.tunnel(true);
      draw();
    } catch (err) {
      fail("Couldn't start the outside link")(err);
    }
  }

  // ---- the page

  const button = (label: string, glyph: Parameters<typeof icon>[0], kind: string, onClick: (b: HTMLButtonElement) => void, title?: string) => {
    const b = h("button", { class: `btn small${kind ? ` ${kind}` : ""}`, type: "button", title: title ?? label }, icon(glyph, 14), label);
    b.addEventListener("click", () => onClick(b));
    return b;
  };

  const sideButtons = h("div", { class: "mt-actions" },
    h("button", { class: "btn primary mt-now", type: "button", onclick: () => void meetNow() }, icon("video", 17), "Meet now"),
    h("button", { class: "mt-action", type: "button", onclick: () => void newCall() }, icon("call", 16), h("span", null, "New call")),
    h("button", { class: "mt-action", type: "button", onclick: () => void schedule() }, icon("calendar", 16), h("span", null, "Schedule")));
  const nav = h("nav", { class: "mt-nav", "aria-label": "Meet" });
  const navItems = new Map<View, { button: HTMLButtonElement; count: HTMLElement }>();
  for (const v of VIEWS) {
    const count = h("span", { class: "mt-count" });
    const b = h("button", { class: "mt-nav-item", type: "button", title: v.label }, icon(v.glyph, 17), h("span", { class: "mt-nav-label" }, v.label), count);
    b.addEventListener("click", () => {
      view = v.id;
      draw();
    });
    nav.append(b);
    navItems.set(v.id, { button: b, count });
  }
  const side = h("aside", { class: "mt-side" }, h("h1", { class: "mt-brand" }, "Meet"), sideButtons, nav);
  const tunnelLine = h("div", { class: "mt-tunnel" });
  const heading = h("h2", { class: "mt-title" });
  const body = h("div", { class: "mt-body" });
  const main = h("div", { class: "mt-main" }, h("header", { class: "mt-head" }, heading, tunnelLine), body);
  const el = h("section", { class: "meet-module" }, side, main);
  new ResizeObserver(() => {
    el.classList.toggle("narrow", el.clientWidth < 900);
    el.classList.toggle("compact", el.clientWidth < 640);
  }).observe(el);

  function drawTunnel() {
    const t = state?.tunnel;
    tunnelLine.replaceChildren();
    tunnelLine.dataset.state = t?.state ?? "off";
    if (!t) return;
    const turnOn = h("button", { class: "mt-link-btn", type: "button", onclick: () => void tunnelOn() }, "Turn on");
    if (t.state === "on" && t.url) {
      const url = h("button", { class: "mt-url", type: "button", title: "Copy the address", onclick: () => void navigator.clipboard?.writeText(t.url!).then(() => toast("Address copied"), () => undefined) }, t.url);
      tunnelLine.append(h("span", { class: "mt-dot" }), "Guests join through ", url);
    } else if (t.state === "starting") {
      tunnelLine.append(h("span", { class: "mt-dot" }), "Starting the outside link…");
    } else if (t.state === "error") {
      tunnelLine.append(h("span", { class: "mt-dot" }), `Outside link failed${t.error ? `: ${t.error}` : ""}. `, h("button", { class: "mt-link-btn", type: "button", onclick: () => void tunnelOn() }, "Try again"));
    } else {
      tunnelLine.append(h("span", { class: "mt-dot" }), "Guest link off: it starts by itself when you share a link. ", turnOn);
    }
  }

  function empty(glyph: Parameters<typeof icon>[0], line: string, sub: string, action: HTMLElement) {
    return h("div", { class: "mt-empty" }, h("div", { class: "mt-empty-icon" }, icon(glyph, 30)), h("strong", null, line), h("p", null, sub), action);
  }

  function inviteeLine(m: Meeting) {
    if (!m.invitees.length) return null;
    return h("div", { class: "mt-people" }, ...m.invitees.map((i) => {
      const status = i.error ? "bad" : i.sentAt ? "sent" : "";
      return h("span", { class: `mt-invitee ${status}`, title: i.error ?? (i.sentAt ? `${i.email}: invitation sent ${dayText(i.sentAt)} ${clockText(i.sentAt)}` : `${i.email}: not sent yet`) },
        i.name || i.email, i.error ? icon("info", 12) : i.sentAt ? icon("check", 12) : null);
    }));
  }

  function meetingCard(m: Meeting, isPastView: boolean) {
    const badges = h("div", { class: "mt-badges" });
    if (m.live) {
      badges.append(h("span", { class: "mt-pill live" }, h("span", { class: "mt-dot" }), "Live"), h("span", { class: "mt-pill" }, icon("users", 12), `${m.people} in the meeting`));
      if (m.waiting) badges.append(h("span", { class: "mt-pill waiting" }, `${m.waiting} waiting`));
      if (m.recording) badges.append(h("span", { class: "mt-pill rec" }, h("span", { class: "mt-dot" }), "REC"));
    } else {
      if (m.kind === "call") badges.append(h("span", { class: "mt-pill" }, icon("call", 12), "Call"));
      if (m.autoRecord) badges.append(h("span", { class: "mt-pill quiet" }, icon("film", 12), "Recorded"));
    }
    const actions = h("div", { class: "mt-card-actions" });
    const menu = (b: HTMLElement) => {
      const items: MenuItem[] = [];
      if (!isPastView) {
        items.push({ label: "Send Invites Again", icon: "send", action: () => void resend(m, b) }, { label: "Edit…", icon: "pencil", action: () => void schedule(m) }, "separator");
      } else {
        items.push({ label: "Copy Link", icon: "link", action: () => void copyLink(m) }, "separator");
      }
      items.push({ label: "Delete…", icon: "trash", danger: true, disabled: m.live, action: () => void remove(m) });
      const box = b.getBoundingClientRect();
      openMenu(box.right - 190, box.bottom + 4, items);
    };
    if (m.live) {
      actions.append(button(m.hostIn ? "Open Window" : "Join", "video", "primary", () => void openMeeting(m)), button("Copy link", "link", "", () => void copyLink(m)), button("End", "stop", "danger-soft", () => void end(m)));
    } else if (!isPastView) {
      actions.append(button(m.startsAt === null || m.startsAt - Date.now() < 15 * 60_000 ? "Start" : "Start Early", "video", "primary", () => void openMeeting(m)), button("Copy link", "link", "", () => void copyLink(m)));
    } else {
      const rec = recordings.find((r) => r.meetingId === m.id);
      if (rec) actions.append(button("Recording", "film", "", () => shell.open({ kind: "video", path: rec.path })));
    }
    const more = h("button", { class: "icon-btn mt-more", type: "button", title: "More", "aria-label": "More", onclick: () => menu(more) }, icon("more", 16));
    actions.append(more);
    return h("article", { class: `mt-card${m.live ? " live" : ""}` },
      h("div", { class: "mt-card-main" },
        h("div", { class: `mt-card-icon${m.live ? " live" : ""}` }, icon(m.kind === "call" ? "call" : "video", 20)),
        h("div", { class: "mt-card-text" },
          h("h3", null, m.title),
          h("p", { class: "mt-when" }, whenText(m), h("span", { class: "mt-code" }, codeText(m.code))),
          badges.childElementCount ? badges : null,
          inviteeLine(m))),
      actions);
  }

  function recordingCard(r: Recording) {
    const live = r.endedAt === null;
    const length = r.endedAt ? durationText((r.endedAt - r.startedAt) / 1000) : null;
    const play = button("Play", "play", "primary", () => shell.open({ kind: "video", path: r.path }));
    play.disabled = live;
    return h("article", { class: "mt-rec" },
      h("div", { class: "mt-thumb", onclick: () => !live && shell.open({ kind: "video", path: r.path }) }, icon("film", 30), live ? h("span", { class: "mt-pill rec" }, h("span", { class: "mt-dot" }), "REC") : length ? h("span", { class: "mt-length" }, length) : null),
      h("div", { class: "mt-rec-text" }, h("h3", { title: r.title }, r.title), h("p", null, `${dayText(r.startedAt)} ${clockText(r.startedAt)}${length ? ` · ${length}` : ""} · ${formatBytes(r.bytes)}`)),
      h("div", { class: "mt-card-actions" }, play,
        button("Show in Files", "folder", "", () => shell.open({ kind: "folder", path: dirname(r.path) })),
        h("button", { class: "icon-btn mt-more", type: "button", title: "Delete", "aria-label": "Delete recording", onclick: () => void deleteRecording(r) }, icon("trash", 16))));
  }

  function draw() {
    const up = upcoming();
    const done = past();
    const counts: Record<View, number> = { upcoming: up.length, past: done.length, recordings: recordings.length };
    for (const v of VIEWS) {
      const item = navItems.get(v.id)!;
      item.button.classList.toggle("active", view === v.id);
      item.count.textContent = counts[v.id] ? String(counts[v.id]) : "";
    }
    const total = up.reduce((n, m) => n + m.waiting, 0);
    navItems.get("upcoming")!.count.classList.toggle("alert", total > 0);
    heading.textContent = VIEWS.find((v) => v.id === view)!.label;
    drawTunnel();
    if (!loaded) return body.replaceChildren(h("p", { class: "mt-loading" }, "Loading…"));
    if (stateError && !state) {
      return body.replaceChildren(empty("video", "Meet isn't available", stateError, button("Try Again", "refresh", "", () => void reload())));
    }
    const meetNowButton = h("button", { class: "btn primary", type: "button", onclick: () => void meetNow() }, icon("video", 15), "Meet now");
    if (view === "recordings") {
      body.replaceChildren(recordings.length
        ? h("div", { class: "mt-grid" }, ...[...recordings].sort((a, b) => b.startedAt - a.startedAt).map(recordingCard))
        : empty("film", "No recordings yet", `Meetings record themselves, and everyone is told. They're saved to ${state?.recordingsDir ?? "your Videos folder"}.`, meetNowButton));
    } else if (view === "upcoming") {
      body.replaceChildren(up.length
        ? h("div", { class: "mt-list" }, ...up.map((m) => meetingCard(m, false)))
        : empty("calendar", "Nothing planned", "Start a meeting now, or schedule one and invite people by e-mail.", h("button", { class: "btn primary", type: "button", onclick: () => void schedule() }, icon("calendar", 15), "Schedule a Meeting")));
    } else {
      body.replaceChildren(done.length
        ? h("div", { class: "mt-list" }, ...done.map((m) => meetingCard(m, true)))
        : empty("clock", "No past meetings", "Meetings you've had will be listed here.", meetNowButton));
    }
  }
  draw();

  return {
    id: "meet",
    title: "Meet",
    icon: "video",
    el,
    activate() {
      visible = true;
      void reload();
      unlisten ??= onMeet("meet-changed", () => visible && void reload());
      window.clearInterval(tick);
      tick = window.setInterval(() => visible && loaded && draw(), 30_000);
    },
    deactivate() {
      visible = false;
      window.clearInterval(tick);
    },
    handleKey: () => false,
    dispose() {
      window.clearInterval(tick);
      void unlisten?.then((stop) => stop());
    },
  };
};
