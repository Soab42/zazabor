import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { showToast } from "../../files/ops/toast";
import { errorText, hasCap, phoneApi, shortTime, type Notif } from "../api";
import type { PhoneCtx, PhoneView } from "../ctx";
import { onEvent } from "../store";
import { emptyState, loadingState } from "../ui";

/**
 * Notifications: what the phone shows in its shade, newest first. Reply where the app offers a
 * reply, use its other buttons, or dismiss it (on the phone too).
 */
export function notificationsView(ctx: PhoneCtx): PhoneView {
  let notifs: Notif[] = [];
  let loading = true;
  let failed: string | null = null;
  /** The notification whose reply box is open, and which action it answers. */
  let replying: { key: string; action: number } | null = null;

  const clearAll = h("button", { class: "btn small ghost", type: "button" }, "Clear All");
  clearAll.addEventListener("click", () => {
    for (const n of notifs.filter((x) => x.clearable)) void dismiss(n);
  });
  const list = h("div", { class: "pl-notif-list" });
  const el = h("div", { class: "pl-pane pl-notifs" },
    h("header", { class: "pl-bar" }, h("div", { class: "pl-bar-row" }, h("h1", { class: "pl-title" }, "Notifications"), h("span", { class: "spacer" }), clearAll)),
    h("div", { class: "pl-notif-scroll" }, list));

  const phoneId = () => ctx.phone()?.phoneId ?? "";

  async function load() {
    const id = phoneId();
    if (!id) return;
    try {
      notifs = (await phoneApi.notifs(id)).sort((a, b) => b.at - a.at);
      failed = null;
    } catch (err) {
      failed = errorText(err);
    }
    loading = false;
    draw();
  }

  async function dismiss(n: Notif) {
    notifs = notifs.filter((x) => x.key !== n.key);
    draw();
    try {
      await phoneApi.notifDismiss(phoneId(), n.key);
    } catch (err) {
      showToast(`Couldn't dismiss: ${errorText(err)}`);
      void load();
    }
  }

  function card(n: Notif): HTMLElement {
    const actions = h("div", { class: "pl-notif-actions" });
    n.actions.forEach((a, i) => {
      const b = h("button", { class: `btn small${a.reply ? "" : " ghost"}`, type: "button" }, a.reply ? icon("reply", 13) : null, a.title);
      b.addEventListener("click", () => {
        if (a.reply) {
          replying = replying?.key === n.key && replying.action === i ? null : { key: n.key, action: i };
          draw();
          (list.querySelector<HTMLInputElement>(".pl-notif-reply input"))?.focus();
        } else {
          b.disabled = true;
          void phoneApi.notifAction(phoneId(), n.key, i).catch((err) => showToast(errorText(err))).finally(() => (b.disabled = false));
        }
      });
      actions.append(b);
    });
    let reply: HTMLElement | null = null;
    if (replying?.key === n.key) {
      const action = replying.action;
      const field = h("input", { class: "pl-input", type: "text", placeholder: `Reply to ${n.title || n.appName}`, "aria-label": "Reply" });
      const send = h("button", { class: "pl-send", type: "button", title: "Send", "aria-label": "Send" }, icon("send", 15));
      const go = async () => {
        const text = field.value.trim();
        if (!text) return;
        field.disabled = send.disabled = true;
        try {
          await phoneApi.notifAction(phoneId(), n.key, action, text);
          replying = null;
          showToast("Reply sent", undefined, 2200);
          draw();
        } catch (err) {
          field.disabled = send.disabled = false;
          showToast(`Not sent: ${errorText(err)}`);
        }
      };
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void go();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          replying = null;
          draw();
        }
      });
      send.addEventListener("click", () => void go());
      reply = h("div", { class: "pl-notif-reply" }, field, send);
    }
    const close = n.clearable ? h("button", { class: "icon-btn small pl-notif-close", type: "button", title: "Dismiss", "aria-label": "Dismiss" }, icon("close", 13)) : null;
    close?.addEventListener("click", () => void dismiss(n));
    return h("article", { class: "pl-notif card" },
      h("div", { class: "pl-notif-head" },
        n.icon ? h("img", { class: "pl-notif-icon", src: n.icon.startsWith("data:") ? n.icon : `data:image/png;base64,${n.icon}`, alt: "" }) : h("span", { class: "pl-notif-icon blank" }, icon("bell", 14)),
        h("span", { class: "pl-notif-app" }, n.appName),
        h("span", { class: "pl-notif-time" }, shortTime(n.at)),
        close),
      n.title ? h("strong", { class: "pl-notif-title" }, n.title) : null,
      n.text ? h("p", { class: "pl-notif-text" }, n.text) : null,
      n.actions.length ? actions : null,
      reply);
  }

  function draw() {
    clearAll.hidden = !notifs.some((n) => n.clearable);
    const phone = ctx.phone();
    if (loading) return list.replaceChildren(loadingState("Loading notifications…"));
    if (!hasCap(phone, "notifications") && !notifs.length) return list.replaceChildren(emptyState("bell", "Notifications aren't shared", "Give Zazabor Link notification access on the phone (Phone Link → Notifications)."));
    if (failed && !notifs.length) return list.replaceChildren(emptyState("bell", "Couldn't load notifications", failed));
    if (!notifs.length) return list.replaceChildren(emptyState("bell", "No notifications", phone?.connected ? "You're all caught up." : "The phone's notifications show while it's linked."));
    list.replaceChildren(...notifs.map(card));
  }

  onEvent("phone-notif", ({ phoneId: from, n }) => {
    if (from !== phoneId()) return;
    notifs = [n, ...notifs.filter((x) => x.key !== n.key)];
    draw();
  });
  onEvent("phone-notif-removed", ({ phoneId: from, key }) => {
    if (from !== phoneId()) return;
    notifs = notifs.filter((x) => x.key !== key);
    if (replying?.key === key) replying = null;
    draw();
  });

  let shownFor = "";
  return {
    el,
    show(phoneChanged) {
      const id = phoneId();
      if (id !== shownFor) {
        notifs = [];
        loading = true;
      }
      if (phoneChanged || id !== shownFor) void load();
      shownFor = id;
      draw();
    },
  };
}
