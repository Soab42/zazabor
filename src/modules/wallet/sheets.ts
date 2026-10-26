import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { confirmDialog, field, openDialog, textArea, textInput, type Dialog } from "../time/dialog";
import { DateTimeField } from "../time/pickers";
import { errorText, walletApi, type Account, type AccountKind, type Category, type Tx } from "./api";
import { ACCOUNT_KIND_ICON, ACCOUNT_KIND_LABEL, CATEGORY_ICONS, COLORS, accountOf, categoryName, fmt, type Ctx, type NewTx } from "./ctx";
import { dateKey, parseDate, plain, symbolOf, todayKey } from "./format";

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

  const fromField = field("From", account);
  const toField = field("To", toAccount);
  const receivedField = field("Arrives as", received.el);
  const feeField = field("Fee", fee.el, { optional: true, note: h("span", { class: "tt-hint" }, "a cash-out charge, booked in Fees") });
  const categoryField = field("Category", category);
  const payeeField = field("Payee", h("div", null, payee, payees), { optional: true });

  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, editing ? "Save" : "Add");
  const remove = editing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null;
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
    ],
    foot: footer(() => dialog, save, [remove]),
    submit: () => void submit(),
  });

  account.addEventListener("change", () => update());
  toAccount.addEventListener("change", () => update());
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
    const from = accountOf(ctx, account.value);
    const to = accountOf(ctx, toAccount.value);
    amount.setCurrency(from?.currency ?? ctx.state().base);
    fee.setCurrency(from?.currency ?? ctx.state().base);
    received.setCurrency(to?.currency ?? ctx.state().base);
    receivedField.hidden = !transfer || !from || !to || from.currency === to.currency;
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

  async function submit() {
    if (!amount.input.value.trim()) return dialog.error("Type the amount.");
    if (mode === "transfer") {
      if (account.value === toAccount.value) return dialog.error("Pick two different accounts.");
      const out = await attempt(dialog, () => walletApi.saveTransfer({
        transferId: tx?.transferId ?? null, from: account.value, to: toAccount.value,
        amount: amount.input.value, received: receivedField.hidden ? null : received.input.value, fee: fee.input.value || null,
        date: dayOf(), note: note.value,
      }));
      if (!out) return;
      ctx.toast(`${editing ? "Saved" : "Moved"} ${fmt(ctx, out.amountMinor, accountOf(ctx, out.from)?.currency)} to ${accountOf(ctx, out.to)?.name ?? "the account"}`);
    } else {
      const saved = await attempt(dialog, () => walletApi.saveTx({
        id: tx?.id ?? null, kind: mode as "expense" | "income", accountId: account.value, amount: amount.input.value,
        date: dayOf(), categoryId: categoryValue, payee: payee.value, note: note.value,
      }));
      if (!saved) return;
      ctx.toast(`${editing ? "Saved" : "Added"} ${fmt(ctx, saved.amountMinor, saved.currency, { signed: true })} · ${categoryName(ctx, saved.categoryId)}`);
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

const PRESETS: [string, AccountKind, string][] = [
  ["Cash", "cash", "green"], ["bKash", "mobile_wallet", "pink"], ["Nagad", "mobile_wallet", "orange"], ["Rocket", "mobile_wallet", "purple"],
  ["Bank account", "bank", "blue"], ["Card", "card", "indigo"], ["Savings", "savings", "teal"],
];

function swatches(value: string, onPick: (color: string) => void): { el: HTMLElement; get(): string } {
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
    ...Object.entries(ACCOUNT_KIND_LABEL).map(([id, label]) => h("option", { value: id, selected: existing?.kind === id }, label)));
  const currency = h("select", { class: "wl-select", "aria-label": "Currency" },
    ...ctx.state().currencies.map((c) => h("option", { value: c.code, selected: (existing?.currency ?? base) === c.code }, `${c.code} — ${c.name}`)));
  const rateNow = (code: string) => ctx.state().rates.find((r) => r.currency === code);
  const rate = textInput({ class: "tt-input wl-rate-input", inputmode: "decimal", placeholder: "122.50", "aria-label": "Rate" });
  const rateLabel = h("span", { class: "wl-rate-label" });
  const rateField = field("Rate", h("div", { class: "wl-rate" }, rateLabel, rate, h("span", { class: "wl-rate-base" }, base)), { note: h("span", { class: "tt-hint" }, "typed by hand; change it any time") });
  const opening = amountField(existing?.currency ?? base, existing ? (existing.openingMinor < 0 ? "-" : "") + plain(existing.openingMinor, existing.currency) : "");
  opening.input.placeholder = "0";
  const color = swatches(existing?.color ?? "blue", () => undefined);
  const presets = existing ? null : h("div", { class: "wl-presets" }, ...PRESETS.map(([label, k, c]) => h("button", {
    type: "button", class: "wl-preset",
    onclick: () => {
      name.value = label === "Bank account" || label === "Card" ? "" : label;
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
  update();

  async function submit() {
    const saved = await attempt(dialog, () => walletApi.saveAccount({
      id: existing?.id ?? null, name: name.value, kind: kind.value as AccountKind, currency: currency.value,
      opening: opening.input.value, color: color.get(), rate: rateField.hidden ? null : rate.value,
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
  const dialog = openDialog({
    title: existing ? `Edit ${existing.name}` : parentId ? "New sub-category" : kind === "income" ? "New income category" : "New spending category",
    icon: "tag",
    tone: "others",
    class: "wl-dialog",
    body: [field("Name", name), field("Inside", parent), field("Icon", icons), field("Colour", color.el)],
    foot: footer(() => dialog, save, [remove]),
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
