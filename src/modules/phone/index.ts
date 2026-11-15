import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ModuleFactory } from "../../shell/module";
import { isMainWindow } from "../../shell/windows";
import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import "../files/ops/ops.css";
import { confirmSheet, nameSheet } from "../files/ops/sheets";
import { showToast } from "../files/ops/toast";
import { agoText, errorText, hasCap, isMock, phoneApi, type Phone } from "./api";
import type { PhoneCtx, PhoneView, Tab } from "./ctx";
import { startPhoneService } from "./global";
import "./phone.css";
import { getBt, getState, getStateError, refreshState, startStore, subscribe } from "./store";
import { createTray } from "./tray";
import { batteryEl, signalEl } from "./ui";
import { callsView } from "./views/calls";
import { filesView } from "./views/files";
import { messagesView } from "./views/messages";
import { notificationsView } from "./views/notifications";
import { photosView } from "./views/photos";
import { renderWelcome } from "./welcome";

const TABS: { id: Tab; label: string; glyph: IconName; cap: string }[] = [
  { id: "messages", label: "Messages", glyph: "message", cap: "sms" },
  { id: "calls", label: "Calls", glyph: "call", cap: "calls" },
  { id: "photos", label: "Photos", glyph: "image", cap: "photos" },
  { id: "files", label: "Files", glyph: "folder", cap: "files" },
  { id: "notifications", label: "Notifications", glyph: "bell", cap: "notifications" },
];

/**
 * Phone: the paired Android phone on this PC, like Windows' Phone Link (docs/plans/phone-link.md
 * §4). A sidebar with the phone's card and the tabs, and the tab's view. Before a phone is paired
 * it shows how to link one. The call bar and the pairing question live in `global.ts`, so they
 * show in every section.
 */
export const createPhoneModule: ModuleFactory = (shell) => {
  if (isMainWindow) startPhoneService(shell);
  let tab: Tab = "messages";
  let visible = false;
  let lastKey = "";
  let mirroring = false;

  const current = (): Phone | null => {
    const phones = getState()?.phones ?? [];
    return phones.find((p) => p.phoneId === shell.config.phone.active) ?? phones[0] ?? null;
  };

  const ctx: PhoneCtx = {
    shell,
    phone: current,
    showTab: (next) => showTab(next),
    messageTo(number) {
      showTab("messages");
      messages.openNumber(number);
    },
    downloadDir: () => shell.config.phone.downloadDir,
    showTransfers: () => tray.show(),
  };

  const messages = messagesView(ctx);
  const files = filesView(ctx);
  const views: Record<Tab, PhoneView> = {
    messages,
    calls: callsView(ctx),
    photos: photosView(ctx),
    files,
    notifications: notificationsView(ctx),
  };
  const tray = createTray(shell);

  // ---- the sidebar
  const card = h("div", { class: "pl-card" });
  const nav = h("nav", { class: "pl-nav", "aria-label": "Phone" });
  const navButtons = new Map<Tab, { button: HTMLButtonElement; badge: HTMLElement }>();
  for (const t of TABS) {
    const badge = h("span", { class: "pl-nav-badge" });
    const button = h("button", { class: "pl-nav-item", type: "button", title: t.label }, icon(t.glyph, 17), h("span", { class: "pl-nav-label" }, t.label), badge);
    button.addEventListener("click", () => showTab(t.id));
    nav.append(button);
    navButtons.set(t.id, { button, badge });
  }
  const side = h("aside", { class: "pl-side" }, card, nav, h("div", { class: "spacer" }), tray.button);

  const main = h("div", { class: "pl-main" }, ...Object.values(views).map((v) => v.el), tray.panel);
  for (const v of Object.values(views)) v.el.hidden = true;
  const dropOverlay = h("div", { class: "pl-drop", hidden: true });
  main.append(dropOverlay);
  const panes = h("div", { class: "pl-panes" }, side, main);
  const welcome = h("div", { class: "pl-welcome", hidden: true });
  const el = h("section", { class: "phone-module" }, panes, welcome);
  new ResizeObserver(() => {
    el.classList.toggle("narrow", el.clientWidth < 980);
    el.classList.toggle("compact", el.clientWidth < 720);
  }).observe(el);

  // ---- the phone's card

  function drawCard() {
    const phone = current();
    if (!phone) return card.replaceChildren();
    const bt = getBt();
    const btPhone = bt?.devices.find((d) => d.connected && (d.phoneId === phone.phoneId || d.name === phone.name)) ?? null;
    const more = h("button", { class: "icon-btn small pl-card-more", type: "button", title: "More", "aria-label": "Phone options" }, icon("more", 16));
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      const others = (getState()?.phones ?? []).filter((p) => p.phoneId !== phone.phoneId);
      const items: MenuItem[] = [
        ...others.map((p): MenuItem => ({ label: `Show ${p.name}`, icon: "phone", action: () => switchTo(p.phoneId) })),
        ...(others.length ? ["separator" as const] : []),
        { label: "Rename…", icon: "pencil", action: () => void rename(phone) },
        { label: "Pair Another Phone", icon: "plus", action: () => showToast(`Open Zazabor Link on the other phone and pick “${getState()?.pcName ?? "this PC"}”.`, undefined, 6000) },
        { label: "Phone Settings", icon: "settings", action: () => shell.openSettings("phone") },
        "separator",
        { label: "Forget This Phone…", icon: "trash", danger: true, action: () => void forget(phone) },
      ];
      openMenu(r.left, r.bottom + 4, items);
    });
    const ring = h("button", { class: "pl-card-action", type: "button", title: "Ring the phone at full volume, to find it" }, icon("bellRing", 16), h("span", null, "Ring"));
    ring.disabled = !phone.connected;
    ring.addEventListener("click", () => void phoneApi.ring(phone.phoneId).then(() => showToast(`${phone.name} is ringing. Touch it to stop.`, undefined, 3500), (err) => showToast(`Couldn't ring: ${errorText(err)}`)));
    const mirror = h("button", { class: `pl-card-action${mirroring ? " active" : ""}`, type: "button", title: mirroring ? "The phone's screen shows in Video" : "Show the phone's screen on this PC" }, icon("cast", 16), h("span", null, mirroring ? "Mirroring" : "Mirror"));
    mirror.disabled = !phone.connected || !hasCap(phone, "mirror");
    mirror.addEventListener("click", () => void startMirror(phone, mirror));

    const status = phone.connected
      ? h("div", { class: "pl-card-status" },
        batteryEl(phone.battery, phone.charging),
        h("span", { class: "pl-card-num" }, phone.battery != null ? `${phone.battery}%` : ""),
        h("span", { class: "pl-card-sep" }),
        signalEl(phone.signal, phone.network),
        phone.network ? h("span", { class: "pl-card-num" }, phone.network) : null,
        phone.carrier ? h("span", { class: "pl-card-carrier", title: phone.carrier }, phone.carrier) : null)
      : h("div", { class: "pl-card-status away" }, `Last seen ${agoText(phone.lastSeen)}`);
    const links = h("div", { class: "pl-card-links" },
      h("span", { class: `pl-link${phone.connected ? " on" : ""}`, title: phone.connected ? "Linked over Wi-Fi" : "Not linked over Wi-Fi" }, icon("wifi", 13), phone.connected ? "Connected" : "Not connected"),
      btPhone ? h("span", { class: "pl-link on", title: "Calls go through this PC over Bluetooth" }, icon("bluetooth", 13), "Calls") : null);
    card.replaceChildren(
      h("div", { class: "pl-card-top" },
        h("span", { class: `pl-card-device${phone.connected ? " on" : ""}` }, icon("phone", 22)),
        h("div", { class: "pl-card-names" }, h("strong", { title: phone.name }, phone.name), h("span", { title: phone.model }, phone.model)),
        more),
      status,
      links,
      h("div", { class: "pl-card-actions" }, ring, mirror));
  }

  function switchTo(phoneId: string) {
    shell.config.phone.active = phoneId;
    shell.saveConfig();
    redraw(true);
  }

  async function rename(phone: Phone) {
    await nameSheet({
      title: "Rename phone",
      name: phone.name,
      isDir: true,
      submitLabel: "Rename",
      taken: new Set(),
      apply: async (name) => {
        await phoneApi.rename(phone.phoneId, name);
        await refreshState();
      },
    });
  }

  async function forget(phone: Phone) {
    const ok = await confirmSheet({
      title: `Forget ${phone.name}?`,
      message: "This PC stops trusting it and drops what it kept from it (texts, calls, contacts). To link it again, pair it from Zazabor Link.",
      confirmLabel: "Forget",
      destructive: true,
    });
    if (!ok) return;
    try {
      await phoneApi.forget(phone.phoneId);
      if (shell.config.phone.active === phone.phoneId) {
        shell.config.phone.active = "";
        shell.saveConfig();
      }
      await refreshState();
    } catch (err) {
      showToast(`Couldn't forget the phone: ${errorText(err)}`);
    }
  }

  /** Mirroring plays through the Cast receiver (in Video): turn it on first if it's off. */
  async function startMirror(phone: Phone, button: HTMLButtonElement) {
    if (!shell.config.features.video) {
      showToast("Mirroring plays in Video. Turn Video on in Settings → Features.", { label: "Settings", run: () => shell.openSettings("features") }, 6000);
      return;
    }
    button.disabled = true;
    try {
      if (!isMock) {
        const { applyReceiver, receiverSettings } = await import("../video/features/receiver/service");
        const settings = receiverSettings(shell.config);
        if (!settings.enabled) {
          settings.enabled = true;
          shell.saveConfig();
          await applyReceiver(shell);
        }
      }
      await phoneApi.mirror(phone.phoneId);
      showToast(`Allow screen sharing on ${phone.name}; its screen then opens in Video.`, undefined, 5000);
    } catch (err) {
      showToast(`Couldn't mirror the screen: ${errorText(err)}`);
    } finally {
      button.disabled = false;
    }
  }

  /** "Mirroring" on the card while the phone's screen plays (Cast's own state). */
  if (shell.config.features.video && !isMock) {
    void import("../video/features/receiver/service").then(({ currentCast, onCastChange }) => {
      const update = () => {
        const now = currentCast()?.source === "mirror";
        if (now === mirroring) return;
        mirroring = now;
        drawCard();
      };
      onCastChange(update);
      update();
    }).catch(() => undefined);
  }

  // ---- tabs

  function drawNav() {
    const phone = current();
    for (const t of TABS) {
      const { button, badge } = navButtons.get(t.id)!;
      button.classList.toggle("active", t.id === tab);
      button.setAttribute("aria-current", t.id === tab ? "page" : "false");
      button.classList.toggle("off", !!phone && !hasCap(phone, t.cap as never) && phone.caps.length > 0);
      const count = t.id === "messages" ? phone?.unreadSms ?? 0 : t.id === "notifications" ? phone?.notifCount ?? 0 : 0;
      badge.textContent = count ? String(count > 99 ? "99+" : count) : "";
      badge.classList.toggle("quiet", t.id === "notifications");
    }
  }

  function showTab(next: Tab) {
    if (next !== tab) views[tab].hide?.();
    tab = next;
    for (const [id, v] of Object.entries(views) as [Tab, PhoneView][]) v.el.hidden = id !== tab;
    drawNav();
    views[tab].show(false);
  }

  /** The phone, its connection or its capabilities changed: views reload what they show. */
  function redraw(force = false) {
    const state = getState();
    const phone = current();
    const none = !phone;
    welcome.hidden = !none;
    panes.hidden = none;
    if (none) {
      renderWelcome(welcome, shell, state, state ? null : getStateError());
      lastKey = "";
      return;
    }
    drawCard();
    drawNav();
    const key = `${phone.phoneId}|${phone.connected}|${phone.caps.join(",")}`;
    if (visible) views[tab].show(force || key !== lastKey);
    lastKey = key;
  }

  // ---- files dropped from the desktop

  let dropping = false;
  const dropTarget = () => {
    const phone = current();
    if (!visible || el.hidden || !phone?.connected || !hasCap(phone, "files") || document.querySelector(".modal-overlay")) return null;
    const dir = tab === "files" ? files.dropDir() : null;
    return { phone, dir };
  };
  function setDropping(on: boolean) {
    dropping = on;
    document.body.classList.toggle("drop-claimed", on);
    document.body.classList.toggle("pl-dropping", on);
    dropOverlay.hidden = !on;
    if (!on) return;
    const target = dropTarget();
    if (!target) return;
    dropOverlay.replaceChildren(h("div", { class: "pl-drop-card glass-strong" },
      icon("upload", 28),
      h("strong", null, `Send to ${target.phone.name}`),
      h("span", null, target.dir ? `Into ${target.dir.split("/").pop()}` : "Into Download/Zazabor")));
  }
  try {
    void getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (document.body.classList.contains("file-picker-open") || document.body.classList.contains("app-locked")) {
        if (dropping) setDropping(false);
        return;
      }
      if (p.type === "enter" || p.type === "over") {
        const want = !!dropTarget();
        if (want !== dropping) setDropping(want);
      } else if (p.type === "drop") {
        const target = dropTarget();
        if (target && dropping && p.paths.length) {
          if (target.dir) files.upload(p.paths);
          else void phoneApi.upload(target.phone.phoneId, p.paths).then(() => tray.show(), (err) => showToast(`Couldn't send: ${errorText(err)}`));
        }
        // The shell reads the claim on this same event; let it go after that.
        window.setTimeout(() => setDropping(false), 120);
      } else if (dropping) {
        setDropping(false);
      }
    }).catch(() => undefined);
  } catch {
    // No webview (a plain browser): no desktop drops.
  }

  // ---- state

  subscribe("state", () => redraw());
  subscribe("bt", () => {
    if (current()) drawCard();
  });
  void startStore().then(() => redraw());
  // Before the backend answers: the welcome screen's first look, not a blank page.
  redraw();

  // Reconnect times ("Last seen 5 min ago") age while the section is open.
  const ageTimer = window.setInterval(() => {
    if (visible && current() && !current()!.connected) drawCard();
  }, 60_000);

  return {
    id: "phone",
    title: "Phone",
    icon: "phone",
    el,
    activate() {
      visible = true;
      if (!getState()) void refreshState();
      for (const [id, v] of Object.entries(views) as [Tab, PhoneView][]) v.el.hidden = id !== tab;
      // (redraw shows the tab: once, loading what it needs.)
      redraw();
    },
    deactivate() {
      visible = false;
      views[tab].hide?.();
      if (dropping) setDropping(false);
    },
    handleKey(e) {
      if (!current()) return false;
      // Alt+1…5 picks a tab.
      if (e.altKey && !e.ctrlKey && /^[1-5]$/.test(e.key)) {
        showTab(TABS[Number(e.key) - 1].id);
        return true;
      }
      return views[tab].handleKey?.(e) ?? false;
    },
    configChanged() {
      redraw();
    },
    guideTopic: () => "phone",
    showGuideTarget(target) {
      if (TABS.some((t) => t.id === target)) showTab(target as Tab);
    },
    dispose() {
      clearInterval(ageTimer);
      if (dropping) setDropping(false);
    },
  };
};
