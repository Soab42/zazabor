import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { confirmDialog, field, openDialog, textArea, textInput, type Dialog } from "../time/dialog";
import { DateTimeField } from "../time/pickers";
import { errorText, walletApi, type Account, type AccountDetails, type AccountKind, type Category, type Tx } from "./api";
import { ACCOUNT_KIND_ICON, ACCOUNT_KIND_LABEL, CATEGORY_ICONS, COLORS, accountOf, categoryName, fmt, type Ctx, type NewTx } from "./ctx";
import { dateKey, parseDate, plain, shortDate, symbolOf, todayKey } from "./format";
import { dropTarget } from "./drops";
import { receiptStrip } from "./receipts";
import { billSheet } from "./views/bills";

/** A category's icon, or "more" for one the icon set doesn't have. */
export function categoryGlyph(name: string | undefined): IconName {
  return (CATEGORY_ICONS as readonly string[]).includes(name ?? "") ? (name as IconName) : "more";
}

/** The round icon chip of a category (or of a transfer). */
export function chip(glyph: IconName, color: string, size = 28): HTMLElement {
  return h("span", { class: `wl-chip wl-c-${color}`, style: { width: `${size}px`, height: `${size}px` } }, icon(glyph, Math.round(size * 0.55)));
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

function footer(dialog: () => Dialog, primary: HTMLButtonElement, left: (Node | null)[] = []): (Node | null)[] {
  return [...left, h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog().close() }, "Cancel"), primary];
}

/** An amount field with the currency's symbol in front. */
function amountField(code: string, value = ""): { el: HTMLElement; input: HTMLInputElement; setCurrency(code: string): void } {
  const symbol = h("span", { class: "wl-amount-symbol" }, symbolOf(code).trim());
  const input = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "0", value, "aria-label": "Amount" });
  return { el: h("div", { class: "wl-amount" }, symbol, input), input, setCurrency: (c) => (symbol.textContent = symbolOf(c).trim()) };
}

/** Accounts to pick from (archived ones only when already chosen). */
function accountSelect(ctx: Ctx, value: string | null, label: string): HTMLSelectElement {
  const select = h("select", { class: "wl-select", "aria-label": label });
  for (const a of ctx.state().accounts.filter((a) => !a.archived || a.id === value)) {
    select.append(h("option", { value: a.id, selected: a.id === value }, `${a.name} · ${fmt(ctx, a.balanceMinor, a.currency)}`));
  }
  return select;
}

/** Categories of a kind, sub-categories indented under their parent; "" is Uncategorised. */
function fillCategories(ctx: Ctx, select: HTMLSelectElement, kind: "expense" | "income", value: string | null) {
  const cats = ctx.state().categories.filter((c) => c.kind === kind && (!c.archived || c.id === value));
  const options: HTMLOptionElement[] = [h("option", { value: "" }, "Uncategorised")];
  for (const top of cats.filter((c) => !c.parentId)) {
    options.push(h("option", { value: top.id }, top.name));
    for (const child of cats.filter((c) => c.parentId === top.id)) options.push(h("option", { value: child.id }, ` ${child.name}`));
  }
  options.push(h("option", { value: "__edit" }, "Edit categories…"));
  select.replaceChildren(...options);
  select.value = value && cats.some((c) => c.id === value) ? value : "";
}

// ---- transactions

/**
 * Add or edit spending, income or a transfer. A transfer moves money between two of your
 * accounts (with the amount that arrives, when their currencies differ, and an optional fee such
 * as a bKash cash-out charge).
 */
export function txSheet(ctx: Ctx, tx: Tx | null, preset: Partial<NewTx> = {}) {
  const editing = !!tx;
  let mode: "expense" | "income" | "transfer" = tx ? tx.kind : preset.kind ?? "expense";
  const firstAccount = ctx.state().accounts.find((a) => !a.archived)?.id ?? null;

  const modes: ["expense" | "income" | "transfer", string, IconName][] = [["expense", "Spending", "trendDown"], ["income", "Income", "trendUp"], ["transfer", "Transfer", "transfer"]];
  const modeButtons = modes.map(([id, label, glyph]) => h("button", { type: "button", onclick: () => setMode(id) }, icon(glyph, 14), label));
  const modeRow = h("div", { class: "segmented wl-modes" }, ...modeButtons);

  const account = accountSelect(ctx, tx?.accountId ?? preset.accountId ?? firstAccount, "Account");
  const toAccount = accountSelect(ctx, preset.toAccountId ?? ctx.state().accounts.find((a) => !a.archived && a.id !== account.value)?.id ?? null, "To account");
  const amount = amountField(accountOf(ctx, account.value)?.currency ?? ctx.state().base, tx ? plain(tx.amountMinor, tx.currency) : preset.amount ?? "");
  amount.input.setAttribute("data-autofocus", "");
  const received = amountField(accountOf(ctx, toAccount.value)?.currency ?? ctx.state().base);
  const fee = amountField(accountOf(ctx, account.value)?.currency ?? ctx.state().base);
  fee.input.placeholder = "None";
  const category = h("select", { class: "wl-select", "aria-label": "Category" });
  let categoryValue = tx?.categoryId ?? preset.categoryId ?? null;
  const date = new DateTimeField({ value: parseDate(tx?.date ?? preset.date ?? todayKey()).getTime(), placeholder: "Pick a day", label: "Date", dateOnly: true, host: () => dialog.overlay });
  const payeeList = `wl-payees-${Math.random().toString(36).slice(2)}`;
  const payee = textInput({ placeholder: "Who was it paid to, or from?", "aria-label": "Payee", list: payeeList, value: tx?.payee ?? preset.payee ?? "" });
  const payees = h("datalist", { id: payeeList }, ...ctx.state().payees.slice(0, 100).map((p) => h("option", { value: p })));
  const note = textArea({ placeholder: "Anything to remember", "aria-label": "Note", rows: 2 });
  note.value = tx?.note ?? preset.note ?? "";

  const receipts = receiptStrip(ctx, tx && tx.kind !== "transfer" ? tx.id : null);
  const receiptsField = field("Receipts", receipts.el, { optional: true });
  const fromField = field("From", account);
  const toField = field("To", toAccount);
  const receivedField = field("Arrives as", received.el);
  const feeField = field("Fee", fee.el, { optional: true, note: h("span", { class: "tt-hint" }, "a cash-out charge, booked in Fees") });
  const categoryField = field("Category", category);
  const payeeField = field("Payee", h("div", null, payee, payees), { optional: true });

  // Repeat it: the same transaction again on a schedule, posted by itself (a bill rule).
  const canRepeat = !tx?.recurringId;
  const repeatOn = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Repeat it" });
  const repeatEvery = textInput({ class: "tt-input wl-every", inputmode: "numeric", value: "1", "aria-label": "Every" });
  const repeatFreq = h("select", { class: "wl-select", "aria-label": "How often" },
    ...([["daily", "days"], ["weekly", "weeks"], ["monthly", "months"], ["yearly", "years"]] as const).map(([v, l]) => h("option", { value: v, selected: v === "monthly" }, l)));
  const repeatAuto = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Post it by itself" });
  repeatAuto.checked = true;
  const repeatNext = h("span", { class: "tt-hint" });
  const repeatMore = h("div", { class: "wl-repeat-more" },
    h("div", { class: "wl-inline" }, h("span", { class: "tt-hint" }, "Every"), repeatEvery, repeatFreq, repeatNext),
    h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, "Auto pay: post it by itself"),
      h("p", { class: "tt-hint" }, "On the day, catching up on days Zazabor Home was closed. Off: Bills reminds you until you mark it as paid.")), repeatAuto));
  const repeatRow = h("div", { class: "wl-repeat" },
    h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, "Repeat it"),
      h("p", { class: "tt-hint" }, "The same again on a schedule, from the next date (listed in Bills).")), repeatOn),
    repeatMore);
  repeatRow.hidden = !canRepeat;
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, editing ? "Save" : "Add");
  const remove = editing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null;
  const repeat = tx && tx.kind !== "transfer" && !tx.recurringId
    ? h("button", { class: "btn ghost", type: "button", title: "Make a bill that repeats this", onclick: () => (dialog.close(), billSheet(ctx, null, tx)) }, icon("repeat", 14), "Repeat…")
    : null;
  let stopDrops = () => {};
  const dialog = openDialog({
    title: editing ? "Edit transaction" : "New transaction",
    subtitle: editing ? "Change any detail; balances follow." : "Spending, income, or money moved between your accounts.",
    icon: "wallet",
    tone: "work",
    class: "wl-dialog",
    body: [
      modeRow,
      h("div", { class: "tt-pair" }, field("Amount", amount.el), field("Date", date.el)),
      fromField, toField, receivedField, feeField, categoryField, payeeField,
      field("Note", note, { optional: true }),
      receiptsField,
      repeatRow,
    ],
    foot: footer(() => dialog, save, [remove, repeat]),
    submit: () => void submit(),
    onClose: () => stopDrops(),
  });
  // Pictures and PDFs dropped on the sheet are its receipts.
  stopDrops = dropTarget(dialog.card, (paths) => mode !== "transfer" && void receipts.add(paths));

  account.addEventListener("change", () => update());
  toAccount.addEventListener("change", () => update());
  for (const el of [repeatOn, repeatFreq]) el.addEventListener("change", () => update());
  repeatEvery.addEventListener("input", () => update());
  category.addEventListener("change", () => {
    if (category.value === "__edit") {
      category.value = categoryValue ?? "";
      categoriesDialog(ctx, mode === "income" ? "income" : "expense", () => (fillCategories(ctx, category, mode === "income" ? "income" : "expense", categoryValue), undefined));
    } else categoryValue = category.value || null;
  });

  function setMode(next: typeof mode) {
    if (editing && (mode === "transfer") !== (next === "transfer")) return;
    mode = next;
    update();
  }

  function update() {
    modeButtons.forEach((b, i) => {
      b.classList.toggle("active", modes[i][0] === mode);
      b.disabled = editing && (modes[i][0] === "transfer") !== (mode === "transfer");
    });
    const transfer = mode === "transfer";
    fromField.querySelector(".tt-label")!.textContent = transfer ? "From" : "Account";
    toField.hidden = !transfer;
    feeField.hidden = !transfer;
    categoryField.hidden = transfer;
    payeeField.hidden = transfer;
    receiptsField.hidden = transfer;
    const from = accountOf(ctx, account.value);
    const to = accountOf(ctx, toAccount.value);
    amount.setCurrency(from?.currency ?? ctx.state().base);
    fee.setCurrency(from?.currency ?? ctx.state().base);
    received.setCurrency(to?.currency ?? ctx.state().base);
    receivedField.hidden = !transfer || !from || !to || from.currency === to.currency;
    repeatMore.hidden = !repeatOn.checked;
    if (repeatOn.checked) repeatNext.textContent = `· next ${shortDate(nextDate())}`;
    if (!transfer) fillCategories(ctx, category, mode === "income" ? "income" : "expense", categoryValue);
  }

  // A transfer being edited comes with its other side and its fee.
  if (tx?.kind === "transfer" && tx.transferId) {
    void walletApi.transfer(tx.transferId).then((t) => {
      account.value = t.from;
      toAccount.value = t.to;
      const from = accountOf(ctx, t.from);
      const to = accountOf(ctx, t.to);
      amount.input.value = plain(t.amountMinor, from?.currency);
      received.input.value = plain(t.receivedMinor, to?.currency);
      fee.input.value = t.feeMinor ? plain(t.feeMinor, from?.currency) : "";
      note.value = t.note;
      update();
    }, (err) => dialog.error(errorText(err)));
  }
  update();

  const dayOf = () => dateKey(new Date(date.get() ?? Date.now()));
  /** The schedule's next date after this one (a month on keeps the day, or the month's last). */
  function nextDate(): string {
    const d = parseDate(dayOf());
    const every = Math.max(1, Math.min(366, Number(repeatEvery.value) || 1));
    switch (repeatFreq.value) {
      case "daily": return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + every));
      case "weekly": return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * every));
      case "yearly": {
        const last = new Date(d.getFullYear() + every, d.getMonth() + 1, 0).getDate();
        return dateKey(new Date(d.getFullYear() + every, d.getMonth(), Math.min(d.getDate(), last)));
      }
      default: {
        const last = new Date(d.getFullYear(), d.getMonth() + every + 1, 0).getDate();
        return dateKey(new Date(d.getFullYear(), d.getMonth() + every, Math.min(d.getDate(), last)));
      }
    }
  }
  /** Makes the rule that repeats what was just saved. */
  async function makeRepeat(): Promise<boolean> {
    const transfer = mode === "transfer";
    const name = transfer ? note.value.trim().slice(0, 120) : payee.value.trim() || note.value.trim().slice(0, 120) || (categoryValue ? "" : mode === "income" ? "Income" : "Spending");
    try {
      await walletApi.saveBill({
        id: null, kind: mode, accountId: account.value, toAccountId: transfer ? toAccount.value : null, amountMode: "fixed", amount: amount.input.value,
        categoryId: transfer ? null : categoryValue, payee: name, note: transfer ? "" : note.value,
        freq: repeatFreq.value as "daily" | "weekly" | "monthly" | "yearly", every: Math.max(1, Math.min(366, Number(repeatEvery.value) || 1)),
        day: repeatFreq.value === "monthly" ? parseDate(dayOf()).getDate() : null, startDate: nextDate(), endDate: null,
        autoPost: repeatAuto.checked, subscription: false, remindDays: 3,
      }, todayKey());
      return true;
    } catch (err) {
      ctx.toast(`Saved, but it can't repeat: ${errorText(err)}`);
      return false;
    }
  }

  async function submit() {
    if (!amount.input.value.trim()) return dialog.error("Type the amount.");
    const repeating = canRepeat && repeatOn.checked;
    if (repeating && mode === "transfer" && !receivedField.hidden) return dialog.error("A transfer repeats between accounts in one currency.");
    if (mode === "transfer") {
      if (account.value === toAccount.value) return dialog.error("Pick two different accounts.");
      const out = await attempt(dialog, () => walletApi.saveTransfer({
        transferId: tx?.transferId ?? null, from: account.value, to: toAccount.value,
        amount: amount.input.value, received: receivedField.hidden ? null : received.input.value, fee: fee.input.value || null,
        date: dayOf(), note: note.value,
      }));
      if (!out) return;
      const repeated = repeating && (await makeRepeat());
      ctx.toast(`${editing ? "Saved" : "Moved"} ${fmt(ctx, out.amountMinor, accountOf(ctx, out.from)?.currency)} to ${accountOf(ctx, out.to)?.name ?? "the account"}${repeated ? `, again from ${shortDate(nextDate())}` : ""}`);
    } else {
      const saved = await attempt(dialog, () => walletApi.saveTx({
        id: tx?.id ?? null, kind: mode as "expense" | "income", accountId: account.value, amount: amount.input.value,
        date: dayOf(), categoryId: categoryValue, payee: payee.value, note: note.value,
      }));
      if (!saved) return;
      if (!editing) await receipts.flush(saved.id);
      const repeated = repeating && (await makeRepeat());
      ctx.toast(`${editing ? "Saved" : "Added"} ${fmt(ctx, saved.amountMinor, saved.currency, { signed: true })} · ${categoryName(ctx, saved.categoryId)}${repeated ? `, again from ${shortDate(nextDate())}` : ""}`);
    }
    ctx.changed();
    dialog.close();
  }

  async function del() {
    if (!tx) return;
    const yes = await confirmDialog({
      title: tx.kind === "transfer" ? "Delete this transfer?" : "Delete this transaction?",
      text: tx.kind === "transfer" ? "Both sides of the transfer (and its fee) go, and the balances change back." : "It's removed from the account's balance and from every report.",
      confirm: "Delete", danger: true, icon: "trash", tone: "idle",
    });
    if (!yes) return;
    if (await attempt(dialog, () => walletApi.deleteTxs([tx.id]))) {
      ctx.toast("Deleted");
      ctx.changed();
      dialog.close();
    }
  }
}

// ---- accounts

/**
 * The optional details of an account, as fits its kind: a bank and its branch with the account
 * number; a mobile wallet's phone number; a card's issuer and last four digits; a person's phone.
 * A note for any.
 */
export function detailsEditor(kind: string, existing: AccountDetails | null | undefined): { el: HTMLElement; get(): AccountDetails; setKind(kind: string): void } {
  const d = existing ?? { institution: "", branch: "", number: "", phone: "", note: "" };
  const institution = textInput({ placeholder: "e.g. BRAC Bank", "aria-label": "Bank", value: d.institution });
  const branch = textInput({ placeholder: "e.g. Gulshan", "aria-label": "Branch", value: d.branch });
  const number = textInput({ placeholder: "Account number", "aria-label": "Account number", value: d.number, inputmode: "text" });
  const phone = textInput({ placeholder: "01XXXXXXXXX", "aria-label": "Phone number", value: d.phone, inputmode: "tel" });
  const note = textInput({ placeholder: "Anything to remember", "aria-label": "Note", value: d.note });
  const institutionField = field("Bank", institution, { optional: true });
  const branchField = field("Branch", branch, { optional: true });
  const numberField = field("Account number", number, { optional: true });
  const phoneField = field("Phone number", phone, { optional: true });
  const el = h("details", { class: "wl-details" },
    h("summary", null, icon("chevronRight", 13), "More details", h("span", { class: "tt-optional" }, " (optional)")),
    h("div", { class: "wl-details-body" },
      h("div", { class: "tt-pair" }, institutionField, branchField),
      h("div", { class: "tt-pair" }, numberField, phoneField),
      field("Note", note, { optional: true })));
  if (d.institution || d.branch || d.number || d.phone || d.note) (el as HTMLDetailsElement).open = true;
  const setKind = (k: string) => {
    const bankish = ["bank", "savings", "dps", "loan", "fdr"].includes(k);
    const card = k === "card";
    institutionField.hidden = !(bankish || card || k === "mobile_wallet");
    institutionField.querySelector(".tt-label")!.firstChild!.textContent = card ? "Issuer" : k === "mobile_wallet" ? "Provider" : "Bank";
    institution.placeholder = card ? "e.g. City Bank Amex" : k === "mobile_wallet" ? "e.g. bKash" : "e.g. BRAC Bank";
    branchField.hidden = !bankish;
    numberField.hidden = !(bankish || card);
    numberField.querySelector(".tt-label")!.firstChild!.textContent = card ? "Last 4 digits" : "Account number";
    number.placeholder = card ? "1234" : "Account number";
    number.inputMode = card ? "numeric" : "text";
    phoneField.hidden = !(k === "mobile_wallet" || k === "person" || k === "cash");
    if (k === "cash") phoneField.hidden = true;
  };
  setKind(kind);
  return {
    el,
    setKind,
    get: () => ({ institution: institution.value, branch: branch.value, number: number.value, phone: phone.value, note: note.value }),
  };
}

/** A short line for an account's details: "BRAC Bank · ••3456", "01711…", "Visa ••1234". */
export function detailsLine(a: { kind: string; details?: AccountDetails }): string {
  const d = a.details;
  if (!d) return "";
  const masked = d.number ? (a.kind === "card" ? `••${d.number}` : d.number.replace(/\s/g, "").length > 4 ? `••${d.number.replace(/\s/g, "").slice(-4)}` : d.number) : "";
  return [d.institution, d.branch, masked, d.phone].filter(Boolean).join(" · ");
}

const PRESETS: [string, AccountKind, string][] = [
  ["Cash", "cash", "green"], ["bKash", "mobile_wallet", "pink"], ["Nagad", "mobile_wallet", "orange"], ["Rocket", "mobile_wallet", "purple"],
  ["Bank account", "bank", "blue"], ["Credit card", "card", "indigo"], ["Savings", "savings", "teal"],
];

export function swatches(value: string, onPick: (color: string) => void): { el: HTMLElement; get(): string } {
  let current = value;
  const buttons = COLORS.map((c) => h("button", { type: "button", class: `wl-swatch wl-c-${c}`, title: c, "aria-label": c, onclick: () => pick(c) }));
  const pick = (c: string) => {
    current = c;
    buttons.forEach((b, i) => b.classList.toggle("active", COLORS[i] === c));
    onPick(c);
  };
  pick(value);
  return { el: h("div", { class: "wl-swatches" }, ...buttons), get: () => current };
}

/** Add or edit an account: name, kind, currency (with its rate), opening balance and colour. */
export function accountSheet(ctx: Ctx, existing: Account | null) {
  const base = ctx.state().base;
  const name = textInput({ placeholder: "e.g. bKash, City Bank, Wallet cash", "aria-label": "Name", value: existing?.name ?? "", "data-autofocus": "" });
  const kind = h("select", { class: "wl-select", "aria-label": "Kind" },
    // A DPS or a loan is added with its terms, in Loans & DPS.
    ...Object.entries(ACCOUNT_KIND_LABEL).filter(([id]) => !["dps", "loan", "person", "fdr"].includes(id) || existing?.kind === id).map(([id, label]) => h("option", { value: id, selected: existing?.kind === id }, label)));
  const currency = h("select", { class: "wl-select", "aria-label": "Currency" },
    ...ctx.state().currencies.map((c) => h("option", { value: c.code, selected: (existing?.currency ?? base) === c.code }, `${c.code} — ${c.name}`)));
  const rateNow = (code: string) => ctx.state().rates.find((r) => r.currency === code);
  const rate = textInput({ class: "tt-input wl-rate-input", inputmode: "decimal", placeholder: "122.50", "aria-label": "Rate" });
  const rateLabel = h("span", { class: "wl-rate-label" });
  const rateField = field("Rate", h("div", { class: "wl-rate" }, rateLabel, rate, h("span", { class: "wl-rate-base" }, base)), { note: h("span", { class: "tt-hint" }, "typed by hand; change it any time") });
  const opening = amountField(existing?.currency ?? base, existing ? (existing.openingMinor < 0 ? "-" : "") + plain(existing.openingMinor, existing.currency) : "");
  opening.input.placeholder = "0";
  const color = swatches(existing?.color ?? "blue", () => undefined);
  const inTotal = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Count in the total balance" });
  inTotal.checked = existing?.inTotal ?? true;
  // A card's terms.
  const dayOptions = (value: number, none: string) => {
    const select = h("select", { class: "wl-select" }, h("option", { value: "0" }, none),
      ...Array.from({ length: 31 }, (_, i) => h("option", { value: String(i + 1) }, `The ${i + 1}${[, "st", "nd", "rd"][(i + 1) % 10 > 3 || [11, 12, 13].includes(i + 1) ? 0 : (i + 1) % 10] ?? "th"}`)));
    select.value = String(value);
    return select;
  };
  const limit = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "e.g. 1,00,000", "aria-label": "Credit limit",
    value: existing?.creditLimitMinor != null ? plain(existing.creditLimitMinor, existing.currency) : "" });
  const statementDay = dayOptions(existing?.statementDay ?? 0, "Not set");
  statementDay.setAttribute("aria-label", "Statement closes on");
  const dueDay = dayOptions(existing?.dueDay ?? 0, "Not set");
  dueDay.setAttribute("aria-label", "Payment due on");
  const details = detailsEditor(existing?.kind ?? "cash", existing?.details);
  const cardFields = h("div", { class: "wl-card-terms" },
    h("div", { class: "wl-card-terms-head" }, icon("card", 14), h("strong", null, "Credit card"),
      h("span", { class: "tt-hint" }, "With these, the card shows what's available and what's due, with Pay Bill and auto-pay")),
    field("Credit limit", limit, { optional: true }),
    h("div", { class: "tt-pair" }, field("Statement closes on", statementDay), field("Payment due on", dueDay)));
  const inTotalRow = h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, "Count in the total balance"),
    h("p", { class: "tt-hint" }, "Off: its balance stays out of the total balance and net worth (money owed, or kept for someone else).")), inTotal);
  const presets = existing ? null : h("div", { class: "wl-presets" }, ...PRESETS.map(([label, k, c]) => h("button", {
    type: "button", class: "wl-preset",
    onclick: () => {
      name.value = label === "Bank account" || label === "Credit card" ? "" : label;
      kind.value = k;
      color.el.querySelectorAll<HTMLButtonElement>(".wl-swatch")[COLORS.indexOf(c as (typeof COLORS)[number])]?.click();
      name.focus();
    },
  }, icon(ACCOUNT_KIND_ICON[k], 14), label)));

  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : "Add Account");
  const archive = existing ? h("button", { class: "btn", type: "button", onclick: () => void toggleArchive() }, icon("archive", 14), existing.archived ? "Unarchive" : "Archive") : null;
  const remove = existing && existing.txCount === 0 ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null;
  const dialog = openDialog({
    title: existing ? "Edit account" : "New account",
    subtitle: existing ? `${existing.txCount} transaction${existing.txCount === 1 ? "" : "s"}` : "Cash, a bank account, bKash or another mobile wallet, a card.",
    icon: existing ? ACCOUNT_KIND_ICON[existing.kind] : "wallet",
    tone: "work",
    class: "wl-dialog",
    body: [
      presets,
      field("Name", name),
      h("div", { class: "tt-pair" }, field("Kind", kind), field("Currency", currency)),
      rateField,
      field("Opening balance", opening.el, { note: h("span", { class: "tt-hint" }, "a minus for money owed, like a card") }),
      cardFields,
      details.el,
      inTotalRow,
      field("Colour", color.el),
    ],
    foot: footer(() => dialog, save, [remove, archive]),
    submit: () => void submit(),
  });
  const update = () => {
    const code = currency.value;
    rateField.hidden = code === base;
    rateLabel.textContent = `1 ${code} =`;
    const known = rateNow(code);
    if (!rate.value && known) rate.value = String(known.rateMicro / 1_000_000);
    opening.setCurrency(code);
    if (existing && existing.txCount > 0) currency.disabled = true;
  };
  currency.addEventListener("change", update);
  const showCard = () => {
    cardFields.hidden = kind.value !== "card";
    details.setKind(kind.value);
  };
  kind.addEventListener("change", showCard);
  showCard();
  update();

  async function submit() {
    const saved = await attempt(dialog, () => walletApi.saveAccount({
      id: existing?.id ?? null, name: name.value, kind: kind.value as AccountKind, currency: currency.value,
      opening: opening.input.value, color: color.get(), rate: rateField.hidden ? null : rate.value, inTotal: inTotal.checked,
      creditLimit: limit.value, statementDay: Number(statementDay.value), dueDay: Number(dueDay.value), details: details.get(),
    }));
    if (!saved) return;
    ctx.toast(existing ? "Account saved" : `Added ${saved.name}`);
    ctx.changed();
    dialog.close();
  }

  async function toggleArchive() {
    if (!existing) return;
    if (await attempt(dialog, () => walletApi.archiveAccount(existing.id, !existing.archived).then(() => true))) {
      ctx.toast(existing.archived ? "Account back in use" : "Archived: its history stays in the reports");
      ctx.changed();
      dialog.close();
    }
  }

  async function del() {
    if (!existing) return;
    const yes = await confirmDialog({ title: `Delete ${existing.name}?`, text: "It has no transactions, so nothing else changes.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (yes && (await attempt(dialog, () => walletApi.deleteAccount(existing.id).then(() => true)))) {
      ctx.toast("Account deleted");
      ctx.changed();
      dialog.close();
    }
  }
}

// ---- categories

/** Every category of a kind, with sub-categories; add, edit or delete them. */
export function categoriesDialog(ctx: Ctx, kind: "expense" | "income" = "expense", closed?: () => void) {
  let showing = kind;
  const tabs: ["expense" | "income", string][] = [["expense", "Spending"], ["income", "Income"]];
  const tabButtons = tabs.map(([id, label]) => h("button", { type: "button", onclick: () => ((showing = id), draw()) }, label));
  const list = h("div", { class: "wl-cat-list" });
  const add = h("button", { class: "btn small", type: "button", onclick: () => categorySheet(ctx, null, showing, null, draw) }, icon("plus", 14), "Add Category");
  const dialog = openDialog({
    title: "Categories",
    subtitle: "Two levels: a category, and sub-categories inside it.",
    icon: "tag",
    tone: "others",
    class: "wl-dialog wl-cats",
    body: [h("div", { class: "wl-cat-head" }, h("div", { class: "segmented" }, ...tabButtons), h("span", { class: "spacer" }), add), list],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn primary", type: "button", onclick: () => dialog.close() }, "Done")],
    onClose: closed,
  });
  function row(c: Category, depth: number): HTMLElement {
    const r = h("div", { class: `wl-cat-row${depth ? " child" : ""}${c.archived ? " archived" : ""}` },
      chip(categoryGlyph(c.icon), c.color, 24),
      h("span", { class: "wl-cat-name" }, c.name),
      h("span", { class: "spacer" }),
      depth === 0 ? h("button", { class: "icon-btn small", type: "button", title: "Add a sub-category", "aria-label": `Add a sub-category to ${c.name}`, onclick: () => categorySheet(ctx, null, c.kind, c.id, draw) }, icon("plus", 13)) : null,
      h("button", { class: "icon-btn small", type: "button", title: "Edit", "aria-label": `Edit ${c.name}`, onclick: () => categorySheet(ctx, c, c.kind, c.parentId, draw) }, icon("pencil", 13)));
    r.addEventListener("dblclick", () => categorySheet(ctx, c, c.kind, c.parentId, draw));
    return r;
  }
  function draw() {
    tabButtons.forEach((b, i) => b.classList.toggle("active", tabs[i][0] === showing));
    const cats = ctx.state().categories.filter((c) => c.kind === showing);
    const rows: HTMLElement[] = [];
    for (const top of cats.filter((c) => !c.parentId)) {
      rows.push(row(top, 0));
      for (const child of cats.filter((c) => c.parentId === top.id)) rows.push(row(child, 1));
    }
    list.replaceChildren(...rows);
  }
  draw();
}

/** Add or edit one category: name, parent, icon and colour; Delete moves its transactions. */
function categorySheet(ctx: Ctx, existing: Category | null, kind: "expense" | "income", parentId: string | null, done: () => void) {
  const name = textInput({ placeholder: "e.g. Groceries", "aria-label": "Name", value: existing?.name ?? "", "data-autofocus": "" });
  const parent = h("select", { class: "wl-select", "aria-label": "Inside" }, h("option", { value: "" }, "— None (a top category) —"),
    ...ctx.state().categories.filter((c) => c.kind === kind && !c.parentId && c.id !== existing?.id).map((c) => h("option", { value: c.id, selected: c.id === parentId }, c.name)));
  const hasChildren = !!existing && ctx.state().categories.some((c) => c.parentId === existing.id);
  parent.disabled = hasChildren;
  let glyph = categoryGlyph(existing?.icon ?? ctx.state().categories.find((c) => c.id === parentId)?.icon ?? "more");
  const icons = h("div", { class: "wl-icons" }, ...CATEGORY_ICONS.map((g) => {
    const b = h("button", { type: "button", class: "wl-icon-pick", title: g, "aria-label": g, onclick: () => ((glyph = g), mark()) }, icon(g, 16));
    b.dataset.glyph = g;
    return b;
  }));
  const mark = () => icons.querySelectorAll<HTMLButtonElement>(".wl-icon-pick").forEach((b) => b.classList.toggle("active", b.dataset.glyph === glyph));
  mark();
  const color = swatches(existing?.color ?? ctx.state().categories.find((c) => c.id === parentId)?.color ?? "gray", () => undefined);
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : "Add");
  const remove = existing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null;
  const archive = existing
    ? h("button", { class: "btn", type: "button", title: existing.archived ? "Use it again" : "Keep its history but leave it out of the pickers", onclick: () => void toggleArchive() }, icon("archive", 14), existing.archived ? "Unarchive" : "Archive")
    : null;
  const dialog = openDialog({
    title: existing ? `Edit ${existing.name}` : parentId ? "New sub-category" : kind === "income" ? "New income category" : "New spending category",
    icon: "tag",
    tone: "others",
    class: "wl-dialog",
    body: [field("Name", name), field("Inside", parent), field("Icon", icons), field("Colour", color.el)],
    foot: footer(() => dialog, save, [remove, archive]),
    submit: () => void submit(),
  });

  async function submit() {
    const saved = await attempt(dialog, () => walletApi.saveCategory({ id: existing?.id ?? null, parentId: parent.value || null, name: name.value, kind, icon: glyph, color: color.get() }));
    if (!saved) return;
    ctx.changed();
    await waitForState(() => ctx.state().categories.some((c) => c.id === saved.id && c.name === saved.name));
    done();
    dialog.close();
  }

  async function toggleArchive() {
    if (!existing) return;
    const done2 = await attempt(dialog, () => walletApi.archiveCategory(existing.id, !existing.archived).then(() => true));
    if (!done2) return;
    ctx.toast(existing.archived ? `${existing.name} is back in the pickers` : `Archived ${existing.name}${hasChildren ? " and its sub-categories" : ""}: its history stays`);
    ctx.changed();
    await waitForState(() => ctx.state().categories.some((c) => c.id === existing.id && c.archived !== existing.archived));
    done();
    dialog.close();
  }

  async function del() {
    if (!existing) return;
    const move = h("select", { class: "wl-select", "aria-label": "Move its transactions to" }, h("option", { value: "" }, "Uncategorised"),
      ...ctx.state().categories.filter((c) => c.kind === kind && c.id !== existing.id && c.parentId !== existing.id).map((c) => h("option", { value: c.id }, categoryName(ctx, c.id, true))));
    let go = false;
    const ok = h("button", { class: "btn tt-danger-solid", type: "button", onclick: () => ((go = true), confirm.close()) }, "Delete");
    const confirm = openDialog({
      title: `Delete ${existing.name}?`,
      subtitle: hasChildren ? "Its sub-categories go too." : undefined,
      icon: "trash",
      tone: "idle",
      class: "tt-confirm",
      body: [field("Move its transactions to", move), h("p", { class: "tt-hint" }, "Budgets set for it are removed.")],
      foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => confirm.close() }, "Cancel"), ok],
      onClose: async () => {
        if (!go) return;
        if (await attempt(dialog, () => walletApi.deleteCategory(existing.id, move.value || null).then(() => true))) {
          ctx.changed();
          await waitForState(() => !ctx.state().categories.some((c) => c.id === existing.id));
          done();
          dialog.close();
        }
      },
    });
  }
}

/** Waits (briefly) until the reloaded state shows a change. */
async function waitForState(ready: () => boolean) {
  for (let i = 0; i < 20 && !ready(); i++) await new Promise((r) => setTimeout(r, 50));
}
