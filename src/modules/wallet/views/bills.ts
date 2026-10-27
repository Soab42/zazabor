import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { confirmDialog, field, openDialog, textArea, textInput, type Dialog } from "../../time/dialog";
import { DateTimeField } from "../../time/pickers";
import { errorText, walletApi, type Bill, type Freq, type Tx } from "../api";
import { accountOf, categoryName, categoryOf, fmt, type Ctx } from "../ctx";
import { dateKey, parseDate, plain, shortDate, symbolOf, todayKey } from "../format";
import { categoryGlyph, chip } from "../sheets";

type Show = "all" | "subscriptions" | "income";

const ORDINAL = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "Every month on the 5th", "Every 2 weeks", "Every year on 29 Feb". */
export function scheduleText(b: Pick<Bill, "freq" | "every" | "day" | "startDate">): string {
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[b.freq];
  const every = b.every > 1 ? `Every ${b.every} ${unit}s` : `Every ${unit}`;
  if (b.freq === "monthly") return `${every} on the ${b.day === 0 ? "last day" : ORDINAL(b.day)}`;
  if (b.freq === "yearly") return `${every} on ${parseDate(b.startDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  if (b.freq === "weekly") return `${every} on ${parseDate(b.startDate).toLocaleDateString(undefined, { weekday: "long" })}s`;
  return every;
}

/** Days from today to a date (negative when it's past). */
function daysUntil(date: string): number {
  return Math.round((parseDate(date).getTime() - parseDate(todayKey()).getTime()) / 86_400_000);
}

/** "Due today", "In 3 days", "2 days late". */
export function dueText(b: Bill): string {
  if (!b.nextDate) return b.lastDate ? `Ended · last ${shortDate(b.lastDate)}` : "Ended";
  if (b.paused) return "Paused";
  const d = daysUntil(b.nextDate);
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  if (d > 1) return d <= 14 ? `In ${d} days` : `Next ${shortDate(b.nextDate)}`;
  return b.overdue > 1 ? `${b.overdue} unpaid · since ${shortDate(b.nextDate)}` : `${-d} day${d === -1 ? "" : "s"} late`;
}

/** The bill's name: its payee, else its category. */
export function billName(ctx: Ctx, b: Bill): string {
  return b.payee || categoryName(ctx, b.categoryId);
}

/** Marks a bill's next due date as paid (asks for the day it was paid when that's not today). */
export async function payBill(ctx: Ctx, b: Bill) {
  try {
    const tx = await walletApi.payBill(b.id, b.nextDate && b.nextDate > todayKey() ? todayKey() : null, todayKey());
    ctx.toast(`Paid ${billName(ctx, b)}: ${fmt(ctx, tx.amountMinor, tx.currency, { signed: true })}`);
    ctx.changed();
  } catch (err) {
    ctx.toast(errorText(err));
  }
}

/**
 * Bills and other money that repeats: what's due next and when, what each costs a year, and the
 * subscriptions among them. A bill either posts its transaction by itself on the day (catching
 * up on days Zazabor was closed) or reminds you until you mark it as paid.
 */
export function billsView(ctx: Ctx) {
  let bills: Bill[] = [];
  let show: Show = "all";
  const shows: [Show, string][] = [["all", "All"], ["subscriptions", "Subscriptions"], ["income", "Income"]];
  const showButtons = shows.map(([id, label]) => h("button", { type: "button", onclick: () => ((show = id), draw()) }, label));
  const actions = h("div", { class: "wl-view-actions" },
    h("div", { class: "segmented" }, ...showButtons), h("span", { class: "spacer" }),
    h("button", { class: "btn small primary", type: "button", onclick: () => billSheet(ctx, null) }, icon("plus", 14), "New Bill"));
  const summary = h("div", { class: "wl-tiles" });
  const list = h("section", { class: "wl-card wl-bill-list" });
  const el = h("div", { class: "wl-view wl-bills" }, actions, summary, list);

  async function load() {
    try {
      bills = await walletApi.bills(todayKey());
    } catch (err) {
      ctx.toast(errorText(err));
    }
    draw();
  }

  function row(b: Bill): HTMLElement {
    const cat = categoryOf(ctx, b.categoryId);
    const acc = accountOf(ctx, b.accountId);
    const due = b.nextDate && !b.paused ? daysUntil(b.nextDate) : null;
    const late = due != null && due < 0 && !b.autoPost;
    const soon = due != null && due >= 0 && due <= b.remindDays;
    const more = h("button", { class: "icon-btn small", type: "button", title: "More", "aria-label": `More for ${billName(ctx, b)}` }, icon("more", 16));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      menu(b, r.left, r.bottom + 4);
    });
    const payButton = !b.autoPost && b.nextDate && !b.paused && (late || soon)
      ? h("button", { class: `btn small${late ? " primary" : ""}`, type: "button", onclick: (e: Event) => (e.stopPropagation(), void payBill(ctx, b)) }, icon("check", 13), b.kind === "income" ? "Received" : "Mark Paid")
      : null;
    const r = h("div", { class: `wl-bill${b.paused || !b.nextDate ? " dim" : ""}`, role: "button", tabindex: 0, onclick: () => billSheet(ctx, b) },
      chip(categoryGlyph(cat?.icon ?? "repeat"), cat?.color ?? "gray", 30),
      h("div", { class: "wl-bill-text" },
        h("span", { class: "wl-bill-name" }, billName(ctx, b), b.subscription ? h("span", { class: "wl-badge" }, "Subscription") : null),
        h("span", { class: "wl-bill-sub" }, [scheduleText(b), acc?.name, b.autoPost ? "posts itself" : "reminds you"].filter(Boolean).join(" · "))),
      h("div", { class: "wl-bill-due" },
        h("span", { class: `wl-bill-when${late ? " late" : soon ? " soon" : ""}` }, late ? icon("info", 12) : null, dueText(b)),
        b.yearlyBaseMinor != null ? h("span", { class: "wl-bill-year" }, `${fmt(ctx, b.yearlyBaseMinor)} a year`) : null),
      h("span", { class: `wl-tx-amount ${b.kind === "income" ? "in" : "out"}` }, fmt(ctx, b.kind === "income" ? b.amountMinor : -b.amountMinor, b.currency, { signed: true })),
      payButton, more);
    r.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu(b, e.clientX, e.clientY);
    });
    r.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === r) {
        e.preventDefault();
        billSheet(ctx, b);
      }
    });
    return r;
  }

  function menu(b: Bill, x: number, y: number) {
    openMenu(x, y, [
      { label: "Edit…", icon: "pencil", action: () => billSheet(ctx, b) },
      { label: b.kind === "income" ? "Mark as received" : "Mark as paid", icon: "check", disabled: !b.nextDate, action: () => void payBill(ctx, b) },
      { label: "Skip the next one", icon: "skipForward10", disabled: !b.nextDate, action: () => void walletApi.skipBill(b.id, todayKey()).then(() => (ctx.toast(`Skipped ${billName(ctx, b)} on ${shortDate(b.nextDate!)}`), ctx.changed()), (err) => ctx.toast(errorText(err))) },
      { label: b.paused ? "Resume" : "Pause", icon: b.paused ? "play" : "pause", action: () => void walletApi.pauseBill(b.id, !b.paused).then(() => ctx.changed(), (err) => ctx.toast(errorText(err))) },
      "separator",
      { label: "Delete…", icon: "trash", danger: true, action: () => void remove(b) },
    ]);
  }

  async function remove(b: Bill) {
    const yes = await confirmDialog({ title: `Delete ${billName(ctx, b)}?`, text: "What it already posted stays, as ordinary transactions.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (!yes) return;
    try {
      await walletApi.deleteBill(b.id);
      ctx.toast("Bill deleted");
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  function draw() {
    showButtons.forEach((b, i) => b.classList.toggle("active", shows[i][0] === show));
    const shown = bills.filter((b) => show === "all" || (show === "subscriptions" ? b.subscription : b.kind === "income"));
    const live = bills.filter((b) => b.nextDate && !b.paused);
    const soon = live.filter((b) => b.kind === "expense" && daysUntil(b.nextDate!) <= 14 && (b.overdue > 0 || daysUntil(b.nextDate!) >= 0));
    const dueSum = soon.reduce((s, b) => s + (b.yearlyBaseMinor != null ? Math.round(b.yearlyBaseMinor / Math.max(1, perYear(b))) : 0) * Math.max(1, b.overdue), 0);
    const monthly = live.filter((b) => b.kind === "expense").reduce((s, b) => s + (b.yearlyBaseMinor ?? 0), 0) / 12;
    const subs = live.filter((b) => b.subscription && b.kind === "expense").reduce((s, b) => s + (b.yearlyBaseMinor ?? 0), 0);
    const tile = (label: string, value: string, sub: string) => h("section", { class: "wl-card wl-tile" }, h("span", { class: "wl-stat-label" }, label), h("strong", { class: "wl-stat-value" }, value), h("span", { class: "wl-card-sub" }, sub));
    summary.replaceChildren(
      tile("Due in the next 14 days", fmt(ctx, dueSum), `${soon.length} bill${soon.length === 1 ? "" : "s"}`),
      tile("Bills a month", fmt(ctx, Math.round(monthly)), "on average, over a year"),
      tile("Subscriptions a year", fmt(ctx, subs), `${live.filter((b) => b.subscription).length} running`));
    list.replaceChildren(
      h("header", { class: "wl-card-head" }, h("div", null, h("h3", null, show === "subscriptions" ? "Subscriptions" : show === "income" ? "Income that repeats" : "Bills"),
        h("p", { class: "wl-card-sub" }, "Soonest first. A bill that posts itself catches up on the days Zazabor was closed."))),
      ...(shown.length ? shown.map(row) : [h("div", { class: "wl-empty small" },
        h("div", { class: "wl-empty-tile glass" }, icon("repeat", 26)),
        h("h2", null, show === "all" ? "No bills yet" : "Nothing here"),
        h("p", null, "Rent, electricity, internet, a Netflix plan or a salary: add what repeats, and Wallet shows what's coming and posts it on the day."),
        h("button", { class: "btn primary", type: "button", onclick: () => billSheet(ctx, null) }, icon("plus", 15), "New Bill"))]));
  }

  return { id: "bills" as const, title: "Bills", el, usesMonth: false, load };
}

/** Payments a year, as the backend counts them. */
function perYear(b: Bill): number {
  const every = Math.max(1, b.every);
  return { daily: 365, weekly: 52, monthly: 12, yearly: 1 }[b.freq] / every;
}

async function attempt<T>(dialog: Dialog, run: () => Promise<T>): Promise<T | null> {
  dialog.busy(true);
  dialog.error("");
  try {
    return await run();
  } catch (err) {
    dialog.error(errorText(err));
    return null;
  } finally {
    dialog.busy(false);
  }
}

/** Add or edit a bill; `from` pre-fills a new one from a transaction ("Repeat…"). */
export function billSheet(ctx: Ctx, existing: Bill | null, from?: Tx) {
  const s = ctx.state();
  let kind: "expense" | "income" = existing?.kind ?? (from && from.amountMinor > 0 ? "income" : "expense");
  const modes: ["expense" | "income", string][] = [["expense", "Spending"], ["income", "Income"]];
  const modeButtons = modes.map(([id, label]) => h("button", { type: "button", onclick: () => ((kind = id), update()) }, label));
  const account = h("select", { class: "wl-select", "aria-label": "Account" },
    ...s.accounts.filter((a) => !a.archived || a.id === existing?.accountId).map((a) => h("option", { value: a.id, selected: a.id === (existing?.accountId ?? from?.accountId) }, a.name)));
  const symbol = h("span", { class: "wl-amount-symbol" });
  const amount = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "0", "aria-label": "Amount", "data-autofocus": "",
    value: existing ? plain(existing.amountMinor, existing.currency) : from ? plain(from.amountMinor, from.currency) : "" });
  const payee = textInput({ placeholder: "e.g. Link3, House rent, Netflix", "aria-label": "Name", value: existing?.payee ?? from?.payee ?? "" });
  const category = h("select", { class: "wl-select", "aria-label": "Category" });
  let categoryValue = existing?.categoryId ?? from?.categoryId ?? null;
  const every = textInput({ class: "tt-input wl-every", inputmode: "numeric", value: String(existing?.every ?? 1), "aria-label": "Every" });
  const freq = h("select", { class: "wl-select", "aria-label": "How often" },
    ...([["daily", "days"], ["weekly", "weeks"], ["monthly", "months"], ["yearly", "years"]] as const).map(([v, l]) => h("option", { value: v, selected: (existing?.freq ?? "monthly") === v }, l)));
  const startGuess = (() => {
    if (existing) return existing.startDate;
    if (from) {
      const d = parseDate(from.date);
      return dateKey(new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), 28)));
    }
    return todayKey();
  })();
  const day = h("select", { class: "wl-select", "aria-label": "Day of the month" },
    ...Array.from({ length: 31 }, (_, i) => h("option", { value: String(i + 1) }, ORDINAL(i + 1))), h("option", { value: "0" }, "Last day"));
  day.value = String(existing?.freq === "monthly" ? existing.day : parseDate(startGuess).getDate());
  const start = new DateTimeField({ value: parseDate(startGuess).getTime(), placeholder: "Pick a day", label: "First date", dateOnly: true, future: true, host: () => dialog.overlay,
    onChange: (v) => {
      if (v != null && !existing) day.value = String(new Date(v).getDate());
    } });
  const end = new DateTimeField({ value: existing?.endDate ? parseDate(existing.endDate).getTime() : null, placeholder: "Never", label: "Ends", dateOnly: true, future: true, clearable: true, host: () => dialog.overlay });
  const auto = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Post it by itself" });
  auto.checked = existing?.autoPost ?? false;
  const subscription = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "A subscription" });
  subscription.checked = existing?.subscription ?? false;
  const remind = textInput({ class: "tt-input wl-every", inputmode: "numeric", value: String(existing?.remindDays ?? 3), "aria-label": "Days before" });
  const note = textArea({ placeholder: "Anything to remember", "aria-label": "Note", rows: 2 });
  note.value = existing?.note ?? "";

  const dayField = field("On", day);
  const remindField = field("Show it", h("div", { class: "wl-inline" }, remind, h("span", { class: "tt-hint" }, "days before it's due")));
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : "Add Bill");
  const remove = existing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null;
  const dialog = openDialog({
    title: existing ? `Edit ${existing.payee || "bill"}` : "New bill",
    subtitle: existing ? `${scheduleText(existing)} · ${dueText(existing)}` : "Rent, a bill, a subscription or a salary: anything that repeats.",
    icon: "repeat",
    tone: "work",
    class: "wl-dialog",
    body: [
      h("div", { class: "segmented wl-modes" }, ...modeButtons),
      h("div", { class: "tt-pair" }, field("Amount", h("div", { class: "wl-amount" }, symbol, amount)), field("Account", account)),
      field("Name", payee),
      field("Category", category),
      h("div", { class: "tt-pair" }, field("Repeats every", h("div", { class: "wl-inline" }, every, freq)), dayField),
      h("div", { class: "tt-pair" }, field("First date", start.el), field("Ends", end.el, { optional: true })),
      h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, "Post it by itself"), h("p", { class: "tt-hint" }, "On the day, and for every date it missed while Zazabor was closed. Off: Wallet reminds you until you mark it as paid.")), auto),
      remindField,
      h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, "A subscription"), h("p", { class: "tt-hint" }, "Listed under Subscriptions, with what they cost a year.")), subscription),
      field("Note", note, { optional: true }),
    ],
    foot: [remove, h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save],
    submit: () => void submit(),
  });

  function fillCategories() {
    const cats = s.categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryValue));
    const options: HTMLOptionElement[] = [h("option", { value: "" }, "Uncategorised")];
    for (const top of cats.filter((c) => !c.parentId)) {
      options.push(h("option", { value: top.id }, top.name));
      for (const child of cats.filter((c) => c.parentId === top.id)) options.push(h("option", { value: child.id }, ` ${child.name}`));
    }
    category.replaceChildren(...options);
    category.value = categoryValue && cats.some((c) => c.id === categoryValue) ? categoryValue : "";
  }
  category.addEventListener("change", () => (categoryValue = category.value || null));
  account.addEventListener("change", () => update());
  freq.addEventListener("change", () => update());
  auto.addEventListener("change", () => update());

  function update() {
    modeButtons.forEach((b, i) => b.classList.toggle("active", modes[i][0] === kind));
    symbol.textContent = symbolOf(accountOf(ctx, account.value)?.currency ?? s.base).trim();
    dayField.hidden = freq.value !== "monthly";
    remindField.hidden = auto.checked;
    fillCategories();
  }
  update();

  async function submit() {
    if (!amount.value.trim()) return dialog.error("Type the amount.");
    const startMs = start.get();
    if (startMs == null) return dialog.error("Pick the first date.");
    const endMs = end.get();
    const saved = await attempt(dialog, () => walletApi.saveBill({
      id: existing?.id ?? null, kind, accountId: account.value, amount: amount.value, categoryId: categoryValue, payee: payee.value, note: note.value,
      freq: freq.value as Freq, every: Math.max(1, Math.min(366, Number(every.value) || 1)), day: freq.value === "monthly" ? Number(day.value) : null,
      startDate: dateKey(new Date(startMs)), endDate: endMs != null ? dateKey(new Date(endMs)) : null,
      autoPost: auto.checked, subscription: subscription.checked, remindDays: Math.max(0, Math.min(60, Number(remind.value) || 0)),
    }, todayKey()));
    if (!saved) return;
    const when = dueText(saved);
    ctx.toast(existing ? "Bill saved" : saved.nextDate ? `Added ${billName(ctx, saved)}: ${when.charAt(0).toLowerCase()}${when.slice(1)}` : `Added ${billName(ctx, saved)}`);
    ctx.changed();
    dialog.close();
  }

  async function del() {
    if (!existing) return;
    const yes = await confirmDialog({ title: `Delete ${billName(ctx, existing)}?`, text: "What it already posted stays, as ordinary transactions.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (yes && (await attempt(dialog, () => walletApi.deleteBill(existing.id).then(() => true)))) {
      ctx.toast("Bill deleted");
      ctx.changed();
      dialog.close();
    }
  }
}
