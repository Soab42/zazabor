import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import type { Account } from "../mail/api";
import { errorText, meetApi, type Invitee, type Meeting, type MeetingInput } from "./api";

/** The sheets of the Meet section: Schedule (and Edit) and New call. */

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Opens a glass sheet over the app; keys inside never reach the shortcuts behind it. */
function openSheet(card: HTMLElement, onEscape: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = h("div", { class: "modal-overlay ops-overlay mt-overlay" }, card);
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
    }
  });
  document.body.append(overlay);
  return () => {
    overlay.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}

const field = (label: string, control: HTMLElement, hint?: string) =>
  h("label", { class: "mt-field" }, h("span", { class: "mt-field-label" }, label), control, hint ? h("span", { class: "mt-field-hint" }, hint) : null);

function toggle(label: string, hint: string, on: boolean) {
  const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
  input.checked = on;
  return { input, el: h("label", { class: "mt-toggle" }, h("div", { class: "mt-toggle-text" }, h("span", null, label), h("small", null, hint)), input) };
}

function accountPicker(accounts: Account[], chosen?: string) {
  const select = h("select", { class: "ops-input mt-select", "aria-label": "Send from" });
  for (const a of accounts) select.append(h("option", { value: a.id }, a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email));
  if (chosen && accounts.some((a) => a.id === chosen)) select.value = chosen;
  return select;
}

/** The last Mail account used to send an invitation, kept for next time. */
const LAST_ACCOUNT = "zazabor.meetAccount";
const lastAccount = () => {
  try { return localStorage.getItem(LAST_ACCOUNT) ?? undefined; } catch { return undefined; }
};
const rememberAccount = (id: string) => {
  try { localStorage.setItem(LAST_ACCOUNT, id); } catch { /* private mode */ }
};

/** E-mail addresses as chips, with completion from Mail's contacts. */
function inviteeField(initial: { email: string; name: string }[], onChange: () => void) {
  const chips = new Map<string, string>(initial.map((i) => [i.email.toLowerCase(), i.name]));
  const names = new Map<string, string>(initial.map((i) => [i.email.toLowerCase(), i.email]));
  const input = h("input", { class: "mt-chip-input", type: "text", placeholder: "Add e-mail addresses", spellcheck: false, autocomplete: "off", "aria-label": "Invitees" });
  const box = h("div", { class: "mt-chips ops-input" });
  const list = h("div", { class: "mt-suggest glass-strong", role: "listbox", hidden: true });
  let suggestions: { name: string; addr: string }[] = [];
  let active = 0;
  let ticket = 0;

  const draw = () => {
    box.replaceChildren(...[...chips].map(([key, name]) => {
      const email = names.get(key) ?? key;
      return h("span", { class: "mt-chip", title: email }, name && name !== email ? name : email,
        h("button", { type: "button", class: "mt-chip-x", "aria-label": `Remove ${email}`, onclick: () => { chips.delete(key); draw(); onChange(); input.focus(); } }, icon("close", 11)));
    }), input);
  };
  const add = (email: string, name = "") => {
    const clean = email.trim();
    if (!EMAIL.test(clean)) return false;
    const key = clean.toLowerCase();
    if (!chips.has(key)) {
      chips.set(key, name);
      names.set(key, clean);
    }
    input.value = "";
    hide();
    draw();
    onChange();
    return true;
  };
  const hide = () => {
    suggestions = [];
    list.hidden = true;
  };
  const show = () => {
    list.hidden = !suggestions.length;
    list.replaceChildren(...suggestions.map((s, i) => h("button", {
      type: "button", class: `mt-suggest-row${i === active ? " active" : ""}`, role: "option",
      onmousedown: (e: Event) => { e.preventDefault(); add(s.addr, s.name); input.focus(); },
    }, h("strong", null, s.name || s.addr), s.name ? h("span", null, s.addr) : null)));
  };
  input.addEventListener("input", () => {
    const text = input.value.trim().replace(/[,;]$/, "");
    if (/[,;]\s*$/.test(input.value) && add(text)) return;
    const mine = ++ticket;
    if (!text) return hide();
    void meetApi.mailContacts(text).then((found) => {
      if (mine !== ticket) return;
      suggestions = found.filter((c) => !chips.has(c.addr.toLowerCase())).slice(0, 6);
      active = 0;
      show();
    }, hide);
  });
  input.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions.length) {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
      show();
    } else if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      const pick = !list.hidden ? suggestions[active] : null;
      if (pick) { e.preventDefault(); add(pick.addr, pick.name); }
      else if (input.value.trim() && add(input.value)) e.preventDefault();
      else if (e.key === "Enter") e.preventDefault();
    } else if (e.key === "Backspace" && !input.value && chips.size) {
      chips.delete([...chips.keys()].pop()!);
      draw();
      onChange();
    }
  });
  input.addEventListener("blur", () => {
    hide();
    if (input.value.trim()) add(input.value);
  });
  box.addEventListener("click", () => input.focus());
  draw();
  return {
    el: h("div", { class: "mt-invitees" }, box, list),
    values: () => [...chips].map(([key, name]) => ({ email: names.get(key) ?? key, name })),
    focus: () => input.focus(),
    /** An address typed but not yet added. */
    pending: () => input.value.trim(),
  };
}

const LENGTHS = [15, 30, 45, 60, 90, 120];
const pad = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export interface ScheduleOptions {
  /** Edit this meeting instead of making a new one. */
  meeting?: Meeting;
  accounts: Account[];
}

/**
 * Schedule (or Edit) a meeting. Saving creates or updates it and sends the invitations through
 * the chosen Mail account. Resolves with what the backend returned, or null when dismissed.
 */
export function scheduleSheet(options: ScheduleOptions): Promise<{ meeting: Meeting; sent: Invitee[] | null; error: string | null } | null> {
  const { meeting, accounts } = options;
  return new Promise((resolve) => {
    let close = () => {};
    let busy = false;
    const soon = new Date(Date.now() + 60 * 60_000);
    soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
    const start = meeting?.startsAt ? new Date(meeting.startsAt) : soon;

    const title = h("input", { class: "ops-input", type: "text", value: meeting?.title ?? "", placeholder: "Team meeting", spellcheck: false, autocomplete: "off", "aria-label": "Title" });
    const date = h("input", { class: "ops-input", type: "date", value: dateValue(start), "aria-label": "Date" });
    const time = h("input", { class: "ops-input", type: "time", value: timeValue(start), "aria-label": "Time" });
    const length = h("select", { class: "ops-input mt-select", "aria-label": "Length" });
    const lengths = LENGTHS.includes(meeting?.minutes ?? 30) ? LENGTHS : [...LENGTHS, meeting!.minutes].sort((a, b) => a - b);
    for (const m of lengths) length.append(h("option", { value: String(m) }, m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`));
    length.value = String(meeting && meeting.minutes > 0 ? meeting.minutes : 30);

    let kind: Meeting["kind"] = meeting?.kind ?? "meeting";
    const kinds = h("div", { class: "segmented", role: "group", "aria-label": "Type" });
    const kindButtons = (["meeting", "call"] as const).map((k) => {
      const b = h("button", { type: "button", class: kind === k ? "active" : "", onclick: () => { kind = k; kindButtons.forEach((x, i) => x.classList.toggle("active", (["meeting", "call"] as const)[i] === k)); } }, k === "meeting" ? "Video meeting" : "Voice call");
      return b;
    });
    kinds.append(...kindButtons);

    const error = h("p", { class: "ops-field-msg", role: "alert" });
    const invitees = inviteeField(meeting?.invitees ?? [], () => update());
    const record = toggle("Record the meeting", "Everyone is told the meeting is recorded", meeting?.autoRecord ?? true);
    const lobby = toggle("Waiting room", "Guests wait until you let them in", meeting?.lobby ?? true);
    const account = accountPicker(accounts, lastAccount());
    const message = h("input", { class: "ops-input", type: "text", placeholder: "Optional note in the invitation", spellcheck: false, autocomplete: "off", "aria-label": "Message" });
    const mail = h("div", { class: "mt-mail" });
    const noMail = h("p", { class: "mt-note" }, icon("mail", 14), "There's no Mail account yet, so invitations can't be sent. You can still save the meeting and copy its link to share yourself.");

    const save = h("button", { class: "btn primary", type: "button" }, meeting ? "Save" : "Schedule");
    const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
    function update() {
      const some = invitees.values().length > 0;
      mail.replaceChildren(...(accounts.length ? (some ? [field("Send invitations from", account), field("Message", message)] : []) : [noMail]));
      save.textContent = meeting ? "Save" : accounts.length && some ? "Schedule and Send" : "Schedule";
    }
    update();

    const finish = (value: Awaited<ReturnType<typeof scheduleSheet>>) => {
      close();
      resolve(value);
    };
    const submit = async () => {
      if (busy) return;
      invitees.pending() && invitees.el.querySelector("input")?.dispatchEvent(new Event("blur"));
      const when = new Date(`${date.value}T${time.value}`);
      if (!title.value.trim()) return fail("Give the meeting a title.", title);
      if (Number.isNaN(when.getTime())) return fail("Pick a date and a time.", date);
      const input: MeetingInput = {
        title: title.value.trim(), kind, startsAt: when.getTime(), minutes: Number(length.value), autoRecord: record.input.checked, lobby: lobby.input.checked,
        invitees: invitees.values(),
      };
      busy = true;
      save.disabled = true;
      error.textContent = "";
      try {
        const saved = meeting ? await meetApi.update(meeting.id, input) : await meetApi.create(input);
        let sent: Invitee[] | null = null;
        let problem: string | null = null;
        const changed = !meeting || meeting.startsAt !== input.startsAt || meeting.title !== input.title || meeting.invitees.length !== input.invitees.length
          || input.invitees.some((i) => !meeting.invitees.some((o) => o.email.toLowerCase() === i.email.toLowerCase()));
        if (input.invitees.length && accounts.length && changed) {
          rememberAccount(account.value);
          try {
            sent = await meetApi.invite(saved.id, account.value, message.value.trim());
          } catch (err) {
            problem = errorText(err);
          }
        }
        finish({ meeting: saved, sent, error: problem });
      } catch (err) {
        busy = false;
        save.disabled = false;
        error.textContent = errorText(err);
      }
    };
    function fail(text: string, on: HTMLElement) {
      error.textContent = text;
      on.focus();
    }
    save.addEventListener("click", () => void submit());
    cancel.addEventListener("click", () => finish(null));
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });

    const card = h("div", { class: "modal ops-sheet mt-sheet", role: "dialog", "aria-modal": "true", "aria-label": meeting ? "Edit meeting" : "Schedule a meeting" },
      h("div", { class: "ops-sheet-body mt-sheet-body" },
        h("div", { class: "ops-sheet-icon" }, icon("calendar", 20)),
        h("div", { class: "ops-sheet-text" },
          h("h2", null, meeting ? "Edit meeting" : "Schedule a meeting"),
          h("div", { class: "mt-form" },
            field("Title", title),
            h("div", { class: "mt-row" }, field("Date", date), field("Time", time), field("Length", length)),
            h("div", { class: "mt-field" }, h("span", { class: "mt-field-label" }, "Type"), kinds),
            h("div", { class: "mt-field" }, h("span", { class: "mt-field-label" }, "Invitees"), invitees.el),
            mail,
            h("div", { class: "mt-toggles" }, record.el, lobby.el),
            error))),
      h("div", { class: "modal-foot ops-sheet-foot" }, h("span", { class: "ops-spacer" }), cancel, save));
    close = openSheet(card, () => finish(null));
    title.focus();
  });
}

/** New call: who to ring (optional) and from which Mail account. */
export function callSheet(accounts: Account[]): Promise<{ invitees: { email: string; name: string }[]; accountId: string } | null> {
  return new Promise((resolve) => {
    let close = () => {};
    const account = accountPicker(accounts, lastAccount());
    const invitees = inviteeField([], () => update());
    const mail = h("div", { class: "mt-mail" });
    const start = h("button", { class: "btn primary", type: "button" }, "Start Call");
    const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
    function update() {
      const some = invitees.values().length > 0;
      mail.replaceChildren(...(some ? (accounts.length ? [field("Send from", account)] : [h("p", { class: "mt-note" }, icon("mail", 14), "There's no Mail account yet. The call starts and its link is copied, so you can send it yourself.")]) : []));
      start.textContent = some && accounts.length ? "Call and Send" : "Start Call";
    }
    update();
    const finish = (value: Awaited<ReturnType<typeof callSheet>>) => {
      close();
      resolve(value);
    };
    const go = () => {
      const field = invitees.el.querySelector("input");
      if (invitees.pending()) field?.dispatchEvent(new Event("blur"));
      const list = invitees.values();
      if (list.length && accounts.length) rememberAccount(account.value);
      finish({ invitees: list, accountId: account.value });
    };
    start.addEventListener("click", go);
    cancel.addEventListener("click", () => finish(null));
    const card = h("div", { class: "modal ops-sheet mt-sheet small", role: "dialog", "aria-modal": "true", "aria-label": "New call" },
      h("div", { class: "ops-sheet-body mt-sheet-body" },
        h("div", { class: "ops-sheet-icon" }, icon("call", 20)),
        h("div", { class: "ops-sheet-text" },
          h("h2", null, "New call"),
          h("p", { class: "ops-sheet-msg" }, "A voice call over the internet. Add e-mail addresses to ring people now, or leave it empty and share the link."),
          h("div", { class: "mt-form" }, h("div", { class: "mt-field" }, h("span", { class: "mt-field-label" }, "Who to call"), invitees.el), mail))),
      h("div", { class: "modal-foot ops-sheet-foot" }, h("span", { class: "ops-spacer" }), cancel, start));
    close = openSheet(card, () => finish(null));
    invitees.focus();
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLInputElement && e.target.value)) {
        e.preventDefault();
        go();
      }
    });
  });
}
