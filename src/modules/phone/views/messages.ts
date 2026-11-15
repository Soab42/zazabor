import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { showToast } from "../../files/ops/toast";
import { agoText, errorText, hasCap, numberKey, phoneApi, shortTime, type Contact, type Msg, type Thread } from "../api";
import { placeCall } from "../callbar";
import type { PhoneCtx, PhoneView } from "../ctx";
import { contactFor, contactList, loadContacts, onEvent, subscribe } from "../store";
import { avatar, emptyState, loadingState, openSheet, staleBanner } from "../ui";

/** What the conversation pane shows: a thread, or a new message to these numbers. */
type Open = { kind: "thread"; threadId: number } | { kind: "draft"; to: string[] } | null;

const PAGE = 50;

/**
 * Messages: the phone's conversations with search, one conversation as bubbles, and a compose
 * box (Enter sends, Shift+Enter starts a new line). "New message" picks a contact or takes a number.
 */
export function messagesView(ctx: PhoneCtx): PhoneView & { openNumber(number: string): void } {
  let threads: Thread[] = [];
  let msgs: Msg[] = [];
  let open: Open = null;
  let loading = true;
  let failed: string | null = null;
  let moreOlder = false;
  let ticket = 0;
  let pendingId = -1;

  // ---- the list
  const search = h("input", { class: "search-input", type: "search", placeholder: "Search messages", "aria-label": "Search messages", spellcheck: "false" });
  search.addEventListener("input", () => drawList());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      drawList();
    }
  });
  const newButton = h("button", { class: "icon-btn", type: "button", title: "New message", "aria-label": "New message" }, icon("pencil", 16));
  newButton.addEventListener("click", () => void pickRecipient());
  const list = h("div", { class: "pl-list", role: "listbox", "aria-label": "Conversations" });
  const listPane = h("section", { class: "pl-list-pane" },
    h("header", { class: "pl-bar pl-list-bar" },
      h("div", { class: "pl-bar-row" }, h("h1", { class: "pl-title" }, "Messages"), h("span", { class: "spacer" }), newButton),
      h("label", { class: "search pl-search" }, icon("search", 15), search)),
    list);

  // ---- the conversation
  const back = h("button", { class: "icon-btn pl-back", type: "button", title: "Back", "aria-label": "Back to conversations" }, icon("chevronLeft", 18));
  back.addEventListener("click", () => select(null));
  const head = h("div", { class: "pl-conv-who" });
  const callButton = h("button", { class: "icon-btn", type: "button", title: "Call", "aria-label": "Call" }, icon("call", 17));
  callButton.addEventListener("click", () => {
    const to = recipients();
    if (to.length === 1) void placeCall(to[0], ctx.phone()?.phoneId ?? null);
  });
  const scroller = h("div", { class: "pl-conv-scroll" });
  const bubbles = h("div", { class: "pl-bubbles" });
  scroller.append(bubbles);
  scroller.addEventListener("scroll", () => {
    if (scroller.scrollTop < 80 && moreOlder && open?.kind === "thread") void loadOlder();
  });
  const input = h("textarea", { class: "pl-compose-input", rows: 1, placeholder: "Text message", "aria-label": "Message", spellcheck: "true" });
  const send = h("button", { class: "pl-send", type: "button", title: "Send (Enter)", "aria-label": "Send" }, icon("send", 17));
  const composeNote = h("p", { class: "pl-compose-note", hidden: true });
  const fit = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    send.disabled = !input.value.trim() || !canSend();
  };
  input.addEventListener("input", fit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendNow();
    }
  });
  send.addEventListener("click", () => void sendNow());
  const compose = h("div", { class: "pl-compose" }, h("div", { class: "pl-compose-box" }, input, send), composeNote);
  const convEmpty = h("div", { class: "pl-conv-empty" }, icon("message", 34), h("p", null, "Pick a conversation, or start a new one."));
  const conv = h("section", { class: "pl-conv empty" },
    h("header", { class: "pl-bar pl-conv-bar" }, back, head, h("span", { class: "spacer" }), callButton),
    scroller, compose, convEmpty);

  const el = h("div", { class: "pl-split pl-messages" }, listPane, conv);

  const phoneId = () => ctx.phone()?.phoneId ?? "";
  const canSend = () => !!ctx.phone()?.connected && hasCap(ctx.phone(), "sms");

  function threadTitle(t: Thread): string {
    if (t.name) return t.name;
    return t.addresses.map((a) => contactFor(phoneId(), a)?.name ?? a).join(", ");
  }

  function threadContact(t: Thread): Contact | null {
    return t.addresses.length === 1 ? contactFor(phoneId(), t.addresses[0]) : null;
  }

  function recipients(): string[] {
    if (open?.kind === "draft") return open.to;
    if (open?.kind === "thread") {
      const id = open.threadId;
      return threads.find((t) => t.threadId === id)?.addresses ?? [];
    }
    return [];
  }

  // ---- loading

  async function loadThreads() {
    const id = phoneId();
    if (!id) return;
    const mine = ++ticket;
    try {
      const next = await phoneApi.threads(id);
      if (mine !== ticket) return;
      threads = next.sort((a, b) => b.at - a.at);
      failed = null;
    } catch (err) {
      if (mine !== ticket) return;
      failed = errorText(err);
    }
    loading = false;
    drawList();
    drawHead();
  }

  async function loadThread(threadId: number) {
    const id = phoneId();
    msgs = [];
    bubbles.replaceChildren(loadingState("Loading the conversation…"));
    try {
      const next = await phoneApi.thread(id, threadId);
      if (open?.kind !== "thread" || open.threadId !== threadId) return;
      msgs = next;
      moreOlder = next.length >= PAGE;
      drawBubbles(true);
    } catch (err) {
      bubbles.replaceChildren(h("p", { class: "pl-error" }, errorText(err)));
    }
  }

  let loadingOlder = false;
  async function loadOlder() {
    if (loadingOlder || open?.kind !== "thread" || !msgs.length) return;
    loadingOlder = true;
    const threadId = open.threadId;
    try {
      const older = await phoneApi.thread(phoneId(), threadId, msgs[0].at);
      if (open?.kind !== "thread" || open.threadId !== threadId) return;
      moreOlder = older.length >= PAGE;
      const known = new Set(msgs.map((m) => m.id));
      const fresh = older.filter((m) => !known.has(m.id));
      if (fresh.length) {
        const from = scroller.scrollHeight - scroller.scrollTop;
        msgs = [...fresh, ...msgs];
        drawBubbles(false);
        scroller.scrollTop = scroller.scrollHeight - from;
      }
    } catch {
      moreOlder = false;
    } finally {
      loadingOlder = false;
    }
  }

  // ---- drawing

  function drawList() {
    if (loading) return list.replaceChildren(loadingState("Loading conversations…"));
    if (failed && !threads.length) return list.replaceChildren(emptyState("message", "Couldn't load messages", failed));
    if (!hasCap(ctx.phone(), "sms") && !threads.length) {
      return list.replaceChildren(emptyState("message", "Messages aren't shared", "Allow Zazabor Link to read your texts on the phone (Phone Link → Messages)."));
    }
    const q = search.value.trim().toLowerCase();
    const digits = numberKey(q);
    const shown = q ? threads.filter((t) => threadTitle(t).toLowerCase().includes(q) || t.snippet.toLowerCase().includes(q) || (digits.length >= 3 && t.addresses.some((a) => numberKey(a).includes(digits)))) : threads;
    if (!shown.length) {
      return list.replaceChildren(q ? h("p", { class: "pl-none" }, `No conversations match “${search.value.trim()}”.`) : emptyState("message", "No messages", "Texts on the phone show up here."));
    }
    const rows = shown.map((t) => {
      const title = threadTitle(t);
      const current = open?.kind === "thread" && open.threadId === t.threadId;
      const row = h("div", { class: `pl-row pl-thread${t.unread ? " unread" : ""}${current ? " current" : ""}`, role: "option", "aria-selected": String(current), tabindex: -1 },
        t.addresses.length > 1 ? h("span", { class: "pl-avatar group" }, icon("users", 18)) : avatar(title, 40, phoneId(), threadContact(t)),
        h("div", { class: "pl-row-main" },
          h("div", { class: "pl-row-top" }, h("span", { class: "pl-row-name" }, title), h("span", { class: "pl-row-date" }, shortTime(t.at))),
          h("div", { class: "pl-row-bottom" }, h("span", { class: "pl-row-snippet" }, t.snippet), t.unread ? h("span", { class: "pl-badge" }, String(t.unread)) : null)));
      row.addEventListener("click", () => select({ kind: "thread", threadId: t.threadId }));
      return row;
    });
    list.replaceChildren(...rows);
  }

  function drawHead() {
    const to = recipients();
    conv.classList.toggle("empty", !open);
    el.classList.toggle("reading", !!open);
    if (!open) return;
    const thread = open.kind === "thread" ? threads.find((t) => t.threadId === (open as { threadId: number }).threadId) : null;
    const title = thread ? threadTitle(thread) : to.map((n) => contactFor(phoneId(), n)?.name ?? n).join(", ") || "New message";
    const sub = to.length === 1 && title !== to[0] ? to[0] : to.length > 1 ? `${to.length} people` : open.kind === "draft" ? "New conversation" : "";
    head.replaceChildren(
      to.length > 1 ? h("span", { class: "pl-avatar group" }, icon("users", 16)) : avatar(title, 32, phoneId(), to.length === 1 ? contactFor(phoneId(), to[0]) : null),
      h("div", { class: "pl-conv-titles" }, h("strong", null, title), sub ? h("span", null, sub) : null));
    callButton.hidden = to.length !== 1;
    const phone = ctx.phone();
    const reason = !phone?.connected ? `${phone?.name ?? "The phone"} isn't connected. Texts send once it's back.` : !hasCap(phone, "sms") ? "Allow Zazabor Link to send texts on the phone." : "";
    composeNote.hidden = !reason;
    composeNote.textContent = reason;
    input.disabled = !phone?.connected || !hasCap(phone, "sms");
    fit();
  }

  const dayKey = (at: number) => new Date(at).toDateString();
  function dayLabel(at: number): string {
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86_400_000).toDateString();
    const key = dayKey(at);
    if (key === today) return "Today";
    if (key === yesterday) return "Yesterday";
    return new Date(at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }

  function drawBubbles(toBottom: boolean) {
    const group = recipients().length > 1;
    const nodes: Node[] = [];
    if (moreOlder) nodes.push(h("div", { class: "pl-older" }, h("span", { class: "spinner" })));
    if (!msgs.length) nodes.push(h("p", { class: "pl-none" }, open?.kind === "draft" ? "Write the first message below." : "No messages."));
    let lastDay = "";
    msgs.forEach((m, i) => {
      if (dayKey(m.at) !== lastDay) {
        lastDay = dayKey(m.at);
        nodes.push(h("div", { class: "pl-day" }, dayLabel(m.at)));
      }
      const next = msgs[i + 1];
      const prev = msgs[i - 1];
      const tail = !next || next.out !== m.out || next.address !== m.address || next.at - m.at > 5 * 60_000;
      const head = !prev || prev.out !== m.out || prev.address !== m.address || m.at - prev.at > 5 * 60_000;
      const time = new Date(m.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const status = m.out && m.status === "failed" ? h("span", { class: "pl-bubble-status failed" }, icon("stAlert", 12), "Not sent")
        : m.out && m.status === "pending" ? h("span", { class: "pl-bubble-status" }, "Sending…") : null;
      nodes.push(h("div", { class: `pl-bubble-row${m.out ? " out" : ""}${tail ? " tail" : ""}` },
        group && !m.out && head ? h("span", { class: "pl-bubble-from" }, contactFor(phoneId(), m.address)?.name ?? m.address) : null,
        h("div", { class: `pl-bubble${m.mms ? " mms" : ""}`, title: new Date(m.at).toLocaleString() },
          h("span", { class: "pl-bubble-text" }, m.body || (m.mms ? "Picture or attachment (open it on the phone)" : "")),
          h("span", { class: "pl-bubble-time" }, time)),
        tail ? status : null));
    });
    bubbles.replaceChildren(...nodes);
    if (toBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  function select(next: Open) {
    open = next;
    msgs = [];
    moreOlder = false;
    input.value = "";
    drawHead();
    drawList();
    if (!next) return;
    if (next.kind === "thread") {
      const thread = threads.find((t) => t.threadId === next.threadId);
      // Read on the PC: the badge goes (the phone keeps its own unread state).
      if (thread?.unread) {
        thread.unread = 0;
        drawList();
      }
      void loadThread(next.threadId);
    } else {
      drawBubbles(true);
    }
    queueMicrotask(() => input.focus());
  }

  async function sendNow() {
    const body = input.value.trim();
    const to = recipients();
    if (!body || !to.length || !canSend()) return;
    const local: Msg = { id: pendingId--, threadId: open?.kind === "thread" ? open.threadId : 0, address: to[0], body, at: Date.now(), out: true, status: "pending", mms: false };
    msgs.push(local);
    input.value = "";
    fit();
    drawBubbles(true);
    try {
      await phoneApi.smsSend(phoneId(), to, body);
    } catch (err) {
      local.status = "failed";
      drawBubbles(true);
      showToast(`Not sent: ${errorText(err)}`);
      input.value = body;
      fit();
    }
  }

  /** A text arrived or was sent: the list moves, and the open conversation gets it. */
  function incoming(msg: Msg) {
    const sameDraft = open?.kind === "draft" && open.to.length === 1 && numberKey(open.to[0]) === numberKey(msg.address);
    if (sameDraft) open = { kind: "thread", threadId: msg.threadId };
    if (open?.kind === "thread" && open.threadId === msg.threadId) {
      if (!msgs.some((m) => m.id === msg.id)) {
        const echo = msg.out ? msgs.findIndex((m) => m.id < 0 && m.body === msg.body) : -1;
        if (echo >= 0) msgs[echo] = msg;
        else msgs.push(msg);
      }
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      drawBubbles(atBottom || msg.out);
    }
    void loadThreads();
  }

  // ---- new message

  async function pickRecipient() {
    const id = phoneId();
    const sheet = openSheet({ title: "New message", icon: "message", width: 440, class: "pl-picker-sheet" });
    const field = h("input", { class: "pl-input", type: "text", placeholder: "Name or number", "aria-label": "To", spellcheck: "false", autocomplete: "off" });
    const results = h("div", { class: "pl-picker-list", role: "listbox" });
    sheet.body.append(h("label", { class: "pl-field" }, h("span", { class: "pl-label" }, "To"), field), results);
    const choose = (number: string) => {
      sheet.close();
      const thread = threads.find((t) => t.addresses.length === 1 && numberKey(t.addresses[0]) === numberKey(number));
      select(thread ? { kind: "thread", threadId: thread.threadId } : { kind: "draft", to: [number] });
    };
    const draw = () => {
      const q = field.value.trim().toLowerCase();
      const digits = numberKey(q);
      const people = contactList(id).filter((c) => c.numbers.length && (!q || c.name.toLowerCase().includes(q) || (digits.length >= 2 && c.numbers.some((n) => numberKey(n.number).includes(digits)))));
      const rows: Node[] = [];
      if (/^[+\d][\d\s()-]{2,}$/.test(field.value.trim())) {
        const typed = field.value.trim();
        const b = h("button", { class: "pl-row pl-pick", type: "button" }, h("span", { class: "pl-avatar" }, icon("message", 16)), h("div", { class: "pl-row-main" }, h("span", { class: "pl-row-name" }, `Send to ${typed}`)));
        b.addEventListener("click", () => choose(typed));
        rows.push(b);
      }
      for (const c of people.slice(0, 60)) {
        for (const n of c.numbers) {
          const b = h("button", { class: "pl-row pl-pick", type: "button" }, avatar(c.name, 32, id, c),
            h("div", { class: "pl-row-main" }, h("span", { class: "pl-row-name" }, c.name), h("span", { class: "pl-row-snippet" }, `${n.number}${n.label ? ` · ${n.label}` : ""}`)));
          b.addEventListener("click", () => choose(n.number));
          rows.push(b);
        }
      }
      if (!rows.length) rows.push(h("p", { class: "pl-none" }, contactList(id).length ? "No contacts match. Type a number to text it." : "Type a number to text it."));
      results.replaceChildren(...rows);
    };
    field.addEventListener("input", draw);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        (results.querySelector<HTMLButtonElement>(".pl-pick"))?.click();
      }
    });
    draw();
    field.focus();
    if (!contactList(id).length) void loadContacts(id).then(draw);
  }

  // ---- events

  onEvent("phone-sms", ({ phoneId: from, msg }) => {
    if (from === phoneId()) incoming(msg);
  });
  subscribe("contacts", () => {
    drawList();
    drawHead();
  });

  let shownFor = "";
  return {
    el,
    show(phoneChanged) {
      const id = phoneId();
      if (phoneChanged || id !== shownFor) {
        if (id !== shownFor) {
          open = null;
          threads = [];
          loading = true;
          drawList();
        }
        shownFor = id;
        void loadThreads();
        void loadContacts(id);
      }
      drawHead();
      const phone = ctx.phone();
      listPane.querySelector(".pl-stale")?.remove();
      if (phone && !phone.connected) list.before(staleBanner(`Last synced ${agoText(phone.lastSeen)}`));
    },
    handleKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        search.focus();
        search.select();
        return true;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        void pickRecipient();
        return true;
      }
      if (e.key === "Escape" && open && el.closest(".narrow")) {
        select(null);
        return true;
      }
      return false;
    },
    openNumber(number: string) {
      const thread = threads.find((t) => t.addresses.length === 1 && numberKey(t.addresses[0]) === numberKey(number));
      select(thread ? { kind: "thread", threadId: thread.threadId } : { kind: "draft", to: [number] });
    },
  };
}
