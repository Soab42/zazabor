import { h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { confirmSheet } from "../../files/ops/sheets";
import { showToast } from "../../files/ops/toast";
import { agoText, duration, errorText, hasCap, numberKey, phoneApi, shortTime, type Call, type CallKind } from "../api";
import { placeCall } from "../callbar";
import type { PhoneCtx, PhoneView } from "../ctx";
import { contactFor, contactList, displayFor, getBt, loadContacts, refreshBt, setBt, subscribe } from "../store";
import { avatar, emptyState, loadingState, staleBanner } from "../ui";

const KIND: Record<CallKind, { glyph: IconName; label: string }> = {
  in: { glyph: "callIn", label: "Incoming" },
  out: { glyph: "callOut", label: "Outgoing" },
  missed: { glyph: "callMissed", label: "Missed" },
  rejected: { glyph: "callMissed", label: "Declined" },
  blocked: { glyph: "callMissed", label: "Blocked" },
  voicemail: { glyph: "callIn", label: "Voicemail" },
};

const KEYS: [string, string][] = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

/**
 * Calls: the phone's call history and contacts, and a dial pad. Calls go through this PC over
 * Bluetooth when that's set up (the "Set up calls through this PC" card), else the phone places
 * them itself and the sound stays on the phone.
 */
export function callsView(ctx: PhoneCtx): PhoneView {
  let mode: "history" | "contacts" = "history";
  let calls: Call[] = [];
  let loading = true;
  let failed: string | null = null;

  const phoneId = () => ctx.phone()?.phoneId ?? "";

  // ---- history and contacts
  const segmented = h("div", { class: "segmented pl-seg" });
  const segButtons = (["history", "contacts"] as const).map((m) => {
    const b = h("button", { type: "button" }, m === "history" ? "History" : "Contacts");
    b.addEventListener("click", () => {
      mode = m;
      search.value = "";
      draw();
    });
    segmented.append(b);
    return [m, b] as const;
  });
  const search = h("input", { class: "search-input", type: "search", placeholder: "Search", "aria-label": "Search", spellcheck: "false" });
  search.addEventListener("input", () => drawList());
  const list = h("div", { class: "pl-list" });
  const listPane = h("section", { class: "pl-list-pane pl-calls-list" },
    h("header", { class: "pl-bar pl-list-bar" },
      h("div", { class: "pl-bar-row" }, h("h1", { class: "pl-title" }, "Calls"), h("span", { class: "spacer" }), segmented),
      h("label", { class: "search pl-search" }, icon("search", 15), search)),
    list);

  // ---- the dial pad
  const number = h("input", { class: "pl-dial-number", type: "tel", placeholder: "Enter a number", "aria-label": "Number", spellcheck: "false", autocomplete: "off" });
  const erase = h("button", { class: "icon-btn pl-dial-erase", type: "button", title: "Delete", "aria-label": "Delete a digit" }, icon("backspace", 18));
  const match = h("div", { class: "pl-dial-match" });
  const pad = h("div", { class: "pl-keypad" });
  for (const [key, letters] of KEYS) {
    const b = h("button", { class: "pl-key", type: "button", "aria-label": key }, h("span", { class: "pl-key-digit" }, key), h("span", { class: "pl-key-letters" }, letters));
    b.addEventListener("click", () => {
      number.value += key;
      number.focus();
      dialChanged();
    });
    // Holding 0 types "+", as on a phone.
    if (key === "0") {
      let hold = 0;
      b.addEventListener("pointerdown", () => (hold = window.setTimeout(() => {
        hold = -1;
        number.value += "+";
        dialChanged();
      }, 550)));
      b.addEventListener("pointerup", () => clearTimeout(hold));
      b.addEventListener("click", (e) => {
        if (hold === -1) {
          e.stopImmediatePropagation();
          number.value = number.value.slice(0, -1);
          dialChanged();
          hold = 0;
        }
      }, { capture: true });
    }
    pad.append(b);
  }
  erase.addEventListener("click", () => {
    number.value = number.value.slice(0, -1);
    dialChanged();
  });
  number.addEventListener("input", dialChanged);
  number.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void dial(number.value);
    }
  });
  const callButton = h("button", { class: "pl-round accept pl-dial-call", type: "button", title: "Call", "aria-label": "Call" }, icon("call", 22));
  callButton.addEventListener("click", () => void dial(number.value));
  const route = h("p", { class: "pl-dial-route" });
  const setup = h("div", { class: "pl-bt-card", hidden: true });
  const dialer = h("section", { class: "pl-dialer" },
    setup,
    h("div", { class: "pl-dial-card" },
      h("div", { class: "pl-dial-display" }, number, erase),
      match,
      pad,
      h("div", { class: "pl-dial-actions" }, callButton),
      route));

  const el = h("div", { class: "pl-split pl-calls-view" }, listPane, dialer);

  function dialChanged() {
    erase.disabled = !number.value;
    const digits = numberKey(number.value);
    match.replaceChildren();
    if (digits.length < 3) return;
    const hit = contactList(phoneId()).find((c) => c.numbers.some((n) => numberKey(n.number).includes(digits)));
    if (!hit) return;
    const n = hit.numbers.find((x) => numberKey(x.number).includes(digits))!;
    const b = h("button", { class: "pl-dial-suggest", type: "button" }, avatar(hit.name, 22, phoneId(), hit), h("span", null, hit.name), h("span", { class: "muted" }, n.number));
    b.addEventListener("click", () => {
      number.value = n.number;
      dialChanged();
    });
    match.append(b);
  }

  async function dial(to: string) {
    if (!to.trim()) return;
    await placeCall(to, phoneId() || null);
  }

  // ---- drawing

  function drawList() {
    if (mode === "history") {
      if (loading) return list.replaceChildren(loadingState("Loading calls…"));
      if (failed && !calls.length) return list.replaceChildren(emptyState("call", "Couldn't load calls", failed));
      if (!hasCap(ctx.phone(), "calls") && !calls.length) return list.replaceChildren(emptyState("call", "Call history isn't shared", "Allow Zazabor Link to read the call log on the phone."));
      const q = search.value.trim().toLowerCase();
      const digits = numberKey(q);
      const shown = calls.filter((c) => !q || displayFor(phoneId(), c.number, c.name).toLowerCase().includes(q) || (digits.length >= 3 && numberKey(c.number).includes(digits)));
      if (!shown.length) return list.replaceChildren(q ? h("p", { class: "pl-none" }, "No calls match.") : emptyState("call", "No calls yet", "Calls made and received on the phone show up here."));
      list.replaceChildren(...shown.map((c) => {
        const name = displayFor(phoneId(), c.number, c.name);
        const kind = KIND[c.kind] ?? KIND.in;
        const missed = c.kind === "missed" || c.kind === "rejected" || c.kind === "blocked";
        const row = h("div", { class: `pl-row pl-call${missed ? " missed" : ""}` },
          avatar(name, 36, phoneId(), contactFor(phoneId(), c.number)),
          h("div", { class: "pl-row-main" },
            h("div", { class: "pl-row-top" }, h("span", { class: "pl-row-name" }, name), h("span", { class: "pl-row-date" }, shortTime(c.at))),
            h("div", { class: "pl-row-bottom" },
              h("span", { class: "pl-call-kind", title: kind.label }, icon(kind.glyph, 13)),
              h("span", { class: "pl-row-snippet" }, `${kind.label}${c.duration ? ` · ${duration(c.duration)}` : ""}${name !== c.number ? ` · ${c.number}` : ""}`))),
          rowActions(c.number));
        row.addEventListener("dblclick", () => void dial(c.number));
        return row;
      }));
    } else {
      const people = contactList(phoneId());
      if (!hasCap(ctx.phone(), "contacts") && !people.length) return list.replaceChildren(emptyState("users", "Contacts aren't shared", "Allow Zazabor Link to read your contacts on the phone."));
      const q = search.value.trim().toLowerCase();
      const digits = numberKey(q);
      const shown = people.filter((c) => !q || c.name.toLowerCase().includes(q) || (digits.length >= 3 && c.numbers.some((n) => numberKey(n.number).includes(digits))));
      if (!shown.length) return list.replaceChildren(q ? h("p", { class: "pl-none" }, "No contacts match.") : emptyState("users", "No contacts", "The phone's contacts show up here."));
      const starred = shown.filter((c) => c.starred);
      const rows: Node[] = [];
      if (starred.length && !q) rows.push(h("div", { class: "pl-group-label" }, "Favourites"), ...starred.map(contactRow), h("div", { class: "pl-group-label" }, "All contacts"));
      rows.push(...shown.map(contactRow));
      list.replaceChildren(...rows);
    }
  }

  function contactRow(c: ReturnType<typeof contactList>[number]): HTMLElement {
    const first = c.numbers[0]?.number ?? "";
    return h("div", { class: "pl-row pl-contact" },
      avatar(c.name, 36, phoneId(), c),
      h("div", { class: "pl-row-main" },
        h("div", { class: "pl-row-top" }, h("span", { class: "pl-row-name" }, c.name), c.starred ? h("span", { class: "pl-star" }, icon("starFilled", 12)) : null),
        h("div", { class: "pl-row-bottom" }, h("span", { class: "pl-row-snippet" }, c.numbers.map((n) => `${n.number}${n.label ? ` (${n.label})` : ""}`).join(" · ")))),
      first ? rowActions(first) : null);
  }

  function rowActions(to: string): HTMLElement {
    const message = h("button", { class: "icon-btn small", type: "button", title: "Message", "aria-label": "Message" }, icon("message", 15));
    message.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.messageTo(to);
    });
    const call = h("button", { class: "icon-btn small pl-call-btn", type: "button", title: `Call ${to}`, "aria-label": "Call" }, icon("call", 15));
    call.addEventListener("click", (e) => {
      e.stopPropagation();
      void dial(to);
    });
    return h("div", { class: "pl-row-actions" }, message, call);
  }

  /** The Bluetooth card over the dial pad, and the line that says how a call goes. */
  function drawSetup() {
    const bt = getBt();
    const phone = ctx.phone();
    const via = bt?.enabled ? bt.devices.find((d) => d.connected) : null;
    route.replaceChildren();
    if (via) route.append(icon("bluetooth", 13), `Calls go through this PC with ${via.name}`);
    else if (phone?.connected) route.append(icon("phone", 13), `${phone.name} places the call; the sound stays on the phone`);
    else route.append(icon("stAlert", 13), "Connect the phone to make calls");
    callButton.disabled = !via && !phone?.connected;

    setup.hidden = !!via;
    if (via) return setup.replaceChildren();
    if (!bt) {
      setup.replaceChildren(h("div", { class: "pl-bt-text" }, h("strong", null, "Calls through this PC"), h("p", null, "This version of Zazabor Home can't talk to Bluetooth phones yet. Calls go through the phone.")));
      return;
    }
    if (!bt.enabled) {
      const go = h("button", { class: "btn primary small", type: "button" }, icon("bluetooth", 14), "Set Up");
      go.addEventListener("click", () => void enableCalls());
      setup.replaceChildren(h("span", { class: "pl-bt-tile" }, icon("bluetooth", 20)),
        h("div", { class: "pl-bt-text" }, h("strong", null, "Set up calls through this PC"),
          h("p", null, "Talk through this PC's speakers and microphone, and see who's calling. Your phone connects over Bluetooth, like a car kit.")),
        go);
      return;
    }
    if (!bt.available) {
      const open = h("button", { class: "btn small", type: "button" }, "Bluetooth Settings");
      open.addEventListener("click", () => void phoneApi.btSettings().catch((err) => showToast(errorText(err))));
      setup.replaceChildren(h("span", { class: "pl-bt-tile warn" }, icon("bluetooth", 20)),
        h("div", { class: "pl-bt-text" }, h("strong", null, "Bluetooth is off"), h("p", null, "Turn Bluetooth on to make and take calls through this PC.")), open);
      return;
    }
    const paired = bt.devices.filter((d) => d.paired);
    const rows = paired.map((d) => {
      const connect = h("button", { class: "btn small", type: "button" }, "Connect");
      connect.addEventListener("click", () => {
        connect.disabled = true;
        connect.replaceChildren(h("span", { class: "spinner" }), "Connecting");
        void phoneApi.btConnect(d.address).catch((err) => showToast(`Couldn't connect: ${errorText(err)}`)).finally(() => void refreshBt());
      });
      return h("div", { class: "pl-bt-device" }, icon("phone", 15), h("span", null, d.name), h("span", { class: "spacer" }), connect);
    });
    const pairNew = h("button", { class: "btn small ghost", type: "button" }, "Pair in Bluetooth Settings");
    pairNew.addEventListener("click", () => void phoneApi.btSettings().catch((err) => showToast(errorText(err))));
    setup.replaceChildren(h("span", { class: "pl-bt-tile" }, icon("bluetooth", 20)),
      h("div", { class: "pl-bt-text" }, h("strong", null, paired.length ? "Connect your phone for calls" : "Pair your phone over Bluetooth"),
        h("p", null, paired.length ? "Pick the phone to take calls through this PC." : "Pair the phone with this PC in Bluetooth settings, then connect it here."),
        ...rows, pairNew));
  }

  async function enableCalls() {
    const ok = await confirmSheet({
      title: "Take calls through this PC?",
      message: "Zazabor Home becomes your phone's Bluetooth hands-free, so calls play on this PC's speakers and use its microphone. To do that it asks the sound server (WirePlumber) to leave the hands-free role to Zazabor Home and restarts it, which cuts sound for a moment. Headsets keep working. You can turn this off in Settings → Phone.",
      confirmLabel: "Set Up Calls",
      icon: "bluetooth",
    });
    if (!ok) return;
    try {
      setBt(await phoneApi.btEnable(true));
      ctx.shell.config.phone.calls = true;
      ctx.shell.saveConfig();
    } catch (err) {
      showToast(`Couldn't set up calls: ${errorText(err)}`);
    }
  }

  function draw() {
    for (const [m, b] of segButtons) b.classList.toggle("active", m === mode);
    search.placeholder = mode === "history" ? "Search calls" : "Search contacts";
    drawList();
    drawSetup();
  }

  async function load() {
    const id = phoneId();
    if (!id) return;
    loading = !calls.length;
    drawList();
    const contactsDone = loadContacts(id);
    try {
      calls = (await phoneApi.calls(id)).sort((a, b) => b.at - a.at);
      failed = null;
    } catch (err) {
      failed = errorText(err);
    }
    await contactsDone;
    loading = false;
    draw();
  }

  subscribe("bt", drawSetup);
  subscribe("contacts", () => drawList());

  let shownFor = "";
  return {
    el,
    show(phoneChanged) {
      const id = phoneId();
      if (id !== shownFor) calls = [];
      if (phoneChanged || id !== shownFor) void load();
      shownFor = id;
      draw();
      dialChanged();
      const phone = ctx.phone();
      listPane.querySelector(".pl-stale")?.remove();
      if (phone && !phone.connected) list.before(staleBanner(`Last synced ${agoText(phone.lastSeen)}`));
    },
    handleKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        search.focus();
        return true;
      }
      // Typing digits anywhere in the tab dials them.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[\d*#+]$/.test(e.key)) {
        number.focus();
        number.value += e.key;
        dialChanged();
        return true;
      }
      return false;
    },
  };
}
