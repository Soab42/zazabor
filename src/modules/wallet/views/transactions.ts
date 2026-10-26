import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { confirmDialog } from "../../time/dialog";
import { DateTimeField, popover } from "../../time/pickers";
import { errorText, walletApi, type Filter, type Tx, type TxKind } from "../api";
import { accountOf, categoryName, categoryOf, fmt, type Ctx } from "../ctx";
import { addMonths, dateKey, dayLabel, monthEnd, monthStart, parseDate, plain, thisMonth, todayKey } from "../format";
import { categoryGlyph, chip } from "../sheets";

const PAGE = 200;

type Period = "month" | "last-month" | "3-months" | "year" | "all" | "custom";
const PERIODS: [Period, string][] = [["month", "This month"], ["last-month", "Last month"], ["3-months", "Last 3 months"], ["year", "This year"], ["all", "All time"], ["custom", "Custom…"]];

/**
 * Every transaction, newest first, grouped by day with each day's total. Filters for the span,
 * account, category and kind, and a search; click to select (Ctrl and Shift for more), and the
 * selection's sum shows at the bottom. Double-click or Enter edits; right-click for more.
 */
export function transactionsView(ctx: Ctx) {
  let period: Period = "month";
  let accountId: string | null = null;
  let categoryId: string | null = null;
  let kind: TxKind | null = null;
  let items: Tx[] = [];
  let total = 0;
  let sums = { income: 0, spending: 0 };
  const selected = new Set<string>();
  let anchor: string | null = null;
  let loading = 0;

  const periodSelect = h("select", { class: "wl-filter-select", "aria-label": "Span" }, ...PERIODS.map(([id, label]) => h("option", { value: id }, label)));
  const from = new DateTimeField({ value: parseDate(monthStart(thisMonth())).getTime(), placeholder: "Start", dateOnly: true, label: "From", host: () => document.body, onChange: () => void load() });
  const to = new DateTimeField({ value: Date.now(), placeholder: "Today", dateOnly: true, label: "To", host: () => document.body, onChange: () => void load() });
  const custom = h("div", { class: "wl-custom" }, from.el, h("span", { class: "wl-dash" }, "–"), to.el);
  const accountSelect = h("select", { class: "wl-filter-select", "aria-label": "Account" });
  const categorySelect = h("select", { class: "wl-filter-select", "aria-label": "Category" });
  const kinds: [TxKind | null, string][] = [[null, "All"], ["expense", "Spending"], ["income", "Income"], ["transfer", "Transfers"]];
  const kindButtons = kinds.map(([id, label]) => h("button", { type: "button", onclick: () => ((kind = id), void load()) }, label));
  const search = h("input", { class: "search-input", type: "search", placeholder: "Search payee, note, category", "aria-label": "Search transactions", spellcheck: "false" });
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void load(), 150);
  });
  periodSelect.addEventListener("change", () => ((period = periodSelect.value as Period), void load()));
  accountSelect.addEventListener("change", () => ((accountId = accountSelect.value || null), void load()));
  categorySelect.addEventListener("change", () => ((categoryId = categorySelect.value || null), void load()));

  const filters = h("div", { class: "wl-filters" }, periodSelect, custom, accountSelect, categorySelect,
    h("div", { class: "segmented" }, ...kindButtons), h("span", { class: "spacer" }),
    h("label", { class: "search wl-search" }, icon("search", 15), search));
  const summary = h("div", { class: "wl-summary" });
  const list = h("div", { class: "wl-tx-list", role: "listbox", "aria-multiselectable": "true", tabindex: 0 });
  const more = h("button", { class: "btn small", type: "button", onclick: () => void load(true) }, "Load more");
  const moreRow = h("div", { class: "wl-more" }, more);
  const selectionBar = h("div", { class: "wl-selection glass-strong" });
  const el = h("div", { class: "wl-view wl-transactions" }, filters, summary, list, moreRow, selectionBar);

  function span(): { from: string | null; to: string | null } {
    const month = thisMonth();
    switch (period) {
      case "month": return { from: monthStart(month), to: monthEnd(month) };
      case "last-month": return { from: monthStart(addMonths(month, -1)), to: monthEnd(addMonths(month, -1)) };
      case "3-months": return { from: monthStart(addMonths(month, -2)), to: monthEnd(month) };
      case "year": return { from: `${month.slice(0, 4)}-01-01`, to: `${month.slice(0, 4)}-12-31` };
      case "all": return { from: null, to: null };
      case "custom": return { from: dateKey(new Date(from.get() ?? Date.now())), to: dateKey(new Date(to.get() ?? Date.now())) };
    }
  }

  function fillSelects() {
    const s = ctx.state();
    accountSelect.replaceChildren(h("option", { value: "" }, "All accounts"),
      ...s.accounts.map((a) => h("option", { value: a.id }, a.archived ? `${a.name} (archived)` : a.name)));
    accountSelect.value = accountId ?? "";
    const options: HTMLOptionElement[] = [h("option", { value: "" }, "All categories")];
    for (const k of ["expense", "income"] as const) {
      const cats = s.categories.filter((c) => c.kind === k);
      for (const top of cats.filter((c) => !c.parentId)) {
        options.push(h("option", { value: top.id }, top.name));
        for (const child of cats.filter((c) => c.parentId === top.id)) options.push(h("option", { value: child.id }, ` ${child.name}`));
      }
    }
    categorySelect.replaceChildren(...options);
    categorySelect.value = categoryId ?? "";
  }

  function filter(offset: number): Filter {
    const { from, to } = span();
    return { from, to, accountId, categoryId, kind, search: search.value.trim() || null, limit: PAGE, offset };
  }

  async function load(append = false) {
    const ticket = ++loading;
    list.classList.add("refreshing");
    try {
      const page = await walletApi.list(filter(append ? items.length : 0));
      if (ticket !== loading) return;
      items = append ? [...items, ...page.items] : page.items;
      total = page.total;
      sums = { income: page.incomeMinor, spending: page.spendingMinor };
      if (!append) for (const id of [...selected]) if (!items.some((t) => t.id === id)) selected.delete(id);
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      if (ticket === loading) list.classList.remove("refreshing");
    }
    draw();
  }

  /** Without an account filter, a transfer shows once ("Cash → bKash"), on its outgoing side. */
  function shown(): Tx[] {
    return accountId ? items : items.filter((t) => !(t.kind === "transfer" && t.amountMinor > 0 && t.counterAccountId));
  }

  function title(t: Tx): string {
    if (t.kind === "transfer") {
      const other = accountOf(ctx, t.counterAccountId)?.name ?? "another account";
      if (!accountId) return `${accountOf(ctx, t.accountId)?.name ?? "Account"} → ${other}`;
      return t.amountMinor < 0 ? `Transfer to ${other}` : `Transfer from ${other}`;
    }
    return t.payee || categoryName(ctx, t.categoryId);
  }

  function row(t: Tx): HTMLElement {
    const cat = categoryOf(ctx, t.categoryId);
    const acc = accountOf(ctx, t.accountId);
    const transferWithoutSide = t.kind === "transfer" && !accountId;
    const sub = t.kind === "transfer"
      ? [t.note].filter(Boolean)
      : [t.payee ? categoryName(ctx, t.categoryId, true) : null, acc?.name, t.note].filter(Boolean);
    const amount = transferWithoutSide ? fmt(ctx, -t.amountMinor, t.currency) : fmt(ctx, t.amountMinor, t.currency, { signed: true });
    const el = h("div", {
      class: `wl-tx${selected.has(t.id) ? " selected" : ""} ${t.kind}`, role: "option", "aria-selected": String(selected.has(t.id)), tabindex: -1,
    },
    t.kind === "transfer" ? chip("transfer", "gray") : chip(categoryGlyph(cat?.icon), cat?.color ?? "gray"),
    h("div", { class: "wl-tx-text" },
      h("span", { class: "wl-tx-title", title: title(t) }, title(t)),
      sub.length ? h("span", { class: "wl-tx-sub", title: sub.join(" · ") }, sub.join(" · ")) : null),
    acc && !accountId && t.kind !== "transfer" ? h("span", { class: `wl-acc-pill wl-c-${acc.color}` }, acc.name) : null,
    h("span", { class: `wl-tx-amount ${t.kind === "income" ? "in" : t.kind === "transfer" ? "move" : "out"}` }, amount));
    el.addEventListener("click", (e) => select(t.id, e.ctrlKey || e.metaKey, e.shiftKey));
    el.addEventListener("dblclick", () => ctx.openTx(t));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!selected.has(t.id)) select(t.id, false, false);
      menu(e.clientX, e.clientY, t);
    });
    return el;
  }

  function draw() {
    fillSelects();
    custom.hidden = period !== "custom";
    kindButtons.forEach((b, i) => b.classList.toggle("active", kinds[i][0] === kind));
    const txs = shown();
    // A transfer counts once, as it shows.
    const count = total - (items.length - txs.length);
    summary.replaceChildren(
      h("span", null, `${count} transaction${count === 1 ? "" : "s"}`),
      h("span", { class: "wl-dot-sep" }, "·"), h("span", null, "In ", h("strong", null, fmt(ctx, sums.income))),
      h("span", { class: "wl-dot-sep" }, "·"), h("span", null, "Out ", h("strong", null, fmt(ctx, sums.spending))));
    if (!txs.length) {
      list.replaceChildren(empty());
    } else {
      const groups: HTMLElement[] = [];
      let day = "";
      let dayTotal = 0;
      let head: HTMLElement | null = null;
      const closeDay = () => head?.append(h("span", { class: "wl-day-total" }, fmt(ctx, dayTotal, undefined, { signed: true })));
      for (const t of txs) {
        if (t.date !== day) {
          closeDay();
          day = t.date;
          dayTotal = 0;
          head = h("div", { class: "wl-day" }, h("span", null, dayLabel(day)));
          groups.push(head);
        }
        if (t.kind !== "transfer") dayTotal += t.baseMinor;
        groups.push(row(t));
      }
      closeDay();
      list.replaceChildren(...groups);
    }
    moreRow.hidden = items.length >= total;
    more.textContent = `Load more (${total - items.length} more)`;
    drawSelection();
  }

  function empty(): HTMLElement {
    const filtered = !!(search.value.trim() || accountId || categoryId || kind) || period !== "all";
    return h("div", { class: "wl-empty" },
      h("div", { class: "wl-empty-tile glass" }, icon(filtered ? "search" : "wallet", 30)),
      h("h2", null, filtered ? "Nothing here" : "No transactions yet"),
      h("p", null, filtered ? "No transactions match these filters. Try a longer span, or All time." : "Type something like “250 lunch bkash” in Quick add above, or add one in full."),
      h("button", { class: "btn primary", type: "button", onclick: () => ctx.openTx(null, { accountId }) }, icon("plus", 15), "New Transaction"));
  }

  function select(id: string, toggle: boolean, range: boolean) {
    const ids = shown().map((t) => t.id);
    if (range && anchor && ids.includes(anchor)) {
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      if (!toggle) selected.clear();
      for (const x of ids.slice(a, b + 1)) selected.add(x);
    } else if (toggle) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    } else {
      selected.clear();
      selected.add(id);
      anchor = id;
    }
    draw();
    list.focus({ preventScroll: true });
  }

  function chosen(): Tx[] {
    return shown().filter((t) => selected.has(t.id));
  }

  function drawSelection() {
    const picked = chosen();
    selectionBar.hidden = picked.length < 1;
    if (!picked.length) return;
    const sum = picked.reduce((s, t) => s + (t.kind === "transfer" ? 0 : t.baseMinor), 0);
    const changeCat = h("button", { class: "btn small", type: "button", onclick: () => categoryPicker(changeCat) }, icon("tag", 14), "Category");
    selectionBar.replaceChildren(...[
      h("span", { class: "wl-sel-count" }, `${picked.length} selected`),
      h("span", { class: "wl-sel-sum" }, fmt(ctx, sum, undefined, { signed: true })),
      h("span", { class: "spacer" }),
      picked.length === 1 ? h("button", { class: "btn small", type: "button", onclick: () => ctx.openTx(picked[0]) }, icon("pencil", 14), "Edit") : null,
      changeCat,
      h("button", { class: "btn small tt-danger", type: "button", onclick: () => void remove(picked) }, icon("trash", 14), "Delete"),
      h("button", { class: "icon-btn small", type: "button", title: "Clear the selection (Esc)", "aria-label": "Clear the selection", onclick: () => (selected.clear(), draw()) }, icon("close", 14)),
    ].filter((n): n is HTMLElement => !!n));
  }

  function categoryPicker(anchorEl: HTMLElement) {
    const picked = chosen().filter((t) => t.kind !== "transfer");
    if (!picked.length) return ctx.toast("Transfers have no category.");
    const kindOf = picked.every((t) => t.kind === "income") ? "income" : "expense";
    const cats = ctx.state().categories.filter((c) => c.kind === kindOf && !c.archived);
    const options = h("div", { class: "tt-options wl-cat-options" });
    const choose = (id: string | null) => {
      pop.close();
      void walletApi.setCategory(picked.map((t) => t.id), id).then((n) => {
        ctx.toast(`${n} moved to ${categoryName(ctx, id)}`);
        ctx.changed();
      }, (err) => ctx.toast(errorText(err)));
    };
    for (const top of cats.filter((c) => !c.parentId)) {
      options.append(h("button", { class: "tt-option", type: "button", onclick: () => choose(top.id) }, chip(categoryGlyph(top.icon), top.color, 22), h("span", { class: "tt-option-text" }, top.name)));
      for (const child of cats.filter((c) => c.parentId === top.id)) {
        options.append(h("button", { class: "tt-option wl-indent", type: "button", onclick: () => choose(child.id) }, chip(categoryGlyph(child.icon), child.color, 22), h("span", { class: "tt-option-text" }, child.name)));
      }
    }
    options.append(h("button", { class: "tt-option", type: "button", onclick: () => choose(null) }, chip("more", "gray", 22), h("span", { class: "tt-option-text" }, "Uncategorised")));
    const pop = popover(anchorEl, options, document.body);
  }

  function menu(x: number, y: number, t: Tx) {
    const many = chosen().length > 1;
    openMenu(x, y, [
      { label: "Edit…", icon: "pencil", action: () => ctx.openTx(t), disabled: many },
      { label: "Duplicate", icon: "copy", disabled: many || t.kind === "transfer", action: () => ctx.openTx(null, { kind: t.kind === "income" ? "income" : "expense", accountId: t.accountId, amount: plain(t.amountMinor, t.currency), categoryId: t.categoryId, payee: t.payee, note: t.note, date: todayKey() }) },
      { label: "Show this account", icon: "wallet", action: () => ctx.go("transactions", { accountId: t.accountId }), disabled: !!accountId },
      "separator",
      { label: many ? `Delete ${chosen().length} transactions` : "Delete", icon: "trash", danger: true, action: () => void remove(chosen()) },
    ]);
  }

  async function remove(txs: Tx[]) {
    if (!txs.length) return;
    const transfers = txs.some((t) => t.kind === "transfer");
    const yes = await confirmDialog({
      title: txs.length === 1 ? "Delete this transaction?" : `Delete ${txs.length} transactions?`,
      text: transfers ? "A transfer goes as a whole: both sides and its fee. Balances change back." : "They're removed from the balances and from every report.",
      confirm: "Delete", danger: true, icon: "trash", tone: "idle",
    });
    if (!yes) return;
    try {
      await walletApi.deleteTxs(txs.map((t) => t.id));
      selected.clear();
      anchor = null;
      ctx.toast(txs.length === 1 ? "Deleted" : `Deleted ${txs.length}`);
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  list.addEventListener("keydown", (e) => {
    const txs = shown();
    const picked = chosen();
    if (e.key === "Delete" && picked.length) {
      e.preventDefault();
      void remove(picked);
    } else if (e.key === "Enter" && picked.length === 1) {
      e.preventDefault();
      ctx.openTx(picked[0]);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && txs.length) {
      e.preventDefault();
      const at = anchor ? txs.findIndex((t) => t.id === anchor) : -1;
      const next = txs[Math.max(0, Math.min(txs.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      select(next.id, false, e.shiftKey);
      list.querySelector(".wl-tx.selected")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      for (const t of txs) selected.add(t.id);
      draw();
    } else if (e.key === "Escape" && selected.size) {
      e.stopPropagation();
      selected.clear();
      draw();
    }
  });

  return {
    id: "transactions" as const,
    title: "Transactions",
    el,
    usesMonth: false,
    load: () => load(),
    /** Starts filtered (an account from the sidebar, a category from a chart). */
    setFilter(f: Filter) {
      accountId = f.accountId ?? null;
      categoryId = f.categoryId ?? null;
      kind = f.kind ?? null;
      search.value = f.search ?? "";
      if (f.from || f.to) {
        period = "custom";
        periodSelect.value = "custom";
        if (f.from) from.set(parseDate(f.from).getTime(), false);
        if (f.to) to.set(parseDate(f.to).getTime(), false);
      } else {
        // An account or a category shows its whole history; nothing at all is this month.
        period = f.accountId || f.categoryId ? "all" : "month";
        periodSelect.value = period;
      }
      selected.clear();
    },
    focusSearch() {
      search.focus();
      search.select();
    },
  };
}
