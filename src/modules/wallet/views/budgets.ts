import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { textInput } from "../../time/dialog";
import { errorText, walletApi, type BudgetRow, type Category } from "../api";
import { categoryOf, fmt, type Ctx } from "../ctx";
import { addMonths, monthEnd, monthLabel, monthStart, plain } from "../format";
import { meter } from "../charts";
import { categoriesDialog, categoryGlyph, chip } from "../sheets";

/**
 * A row per spending category for the month: its budget (click to set or change it), what was
 * spent, and what's left, with a bar that turns amber at 80% and red past 100% (always with
 * words and an icon too, never colour alone). Sub-categories sit under their parent, whose
 * spending includes theirs.
 */
export function budgetsView(ctx: Ctx) {
  let rows: BudgetRow[] = [];
  let editing: string | null = null;
  const summary = h("section", { class: "wl-card wl-budget-summary" });
  const list = h("section", { class: "wl-card wl-budget-list" });
  const copy = h("button", { class: "btn small", type: "button", onclick: () => void copyLast() }, icon("copy", 14), "Copy Last Month");
  const manage = h("button", { class: "btn small ghost", type: "button", onclick: () => categoriesDialog(ctx, "expense", () => void load()) }, icon("tag", 14), "Categories");
  const actions = h("div", { class: "wl-view-actions" }, copy, manage);
  const el = h("div", { class: "wl-view wl-budgets" }, actions, summary, list);

  async function load() {
    try {
      rows = await walletApi.budgets(ctx.month());
    } catch (err) {
      ctx.toast(errorText(err));
    }
    draw();
  }

  function status(budget: number | null, spent: number): HTMLElement {
    if (budget == null) return h("span", { class: "wl-budget-status none" }, spent ? `${fmt(ctx, spent)} spent` : "No budget");
    const left = budget - spent;
    if (left < 0) return h("span", { class: "wl-budget-status over" }, icon("info", 13), `${fmt(ctx, -left)} over`);
    if (budget > 0 && spent / budget >= 0.8) return h("span", { class: "wl-budget-status near" }, icon("info", 13), `${fmt(ctx, left)} left`);
    return h("span", { class: "wl-budget-status ok" }, `${fmt(ctx, left)} left`);
  }

  function amountEditor(c: Category, budget: number | null): HTMLElement {
    const input = textInput({ class: "tt-input wl-budget-input", inputmode: "decimal", placeholder: "Budget", value: budget != null ? plain(budget) : "", "aria-label": `Budget for ${c.name}` });
    const save = async () => {
      editing = null;
      try {
        await walletApi.setBudget(ctx.month(), c.id, input.value);
        ctx.changed();
      } catch (err) {
        ctx.toast(errorText(err));
        draw();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        editing = null;
        draw();
      }
    });
    input.addEventListener("blur", () => editing === c.id && void save());
    requestAnimationFrame(() => (input.focus(), input.select()));
    return input;
  }

  function row(r: BudgetRow, child: boolean): HTMLElement | null {
    const c = categoryOf(ctx, r.categoryId);
    if (!c) return null;
    const budget = r.budgetMinor;
    const amount = editing === c.id
      ? amountEditor(c, budget)
      : h("button", { class: `text-btn wl-budget-amount${budget == null ? " unset" : ""}`, type: "button", title: "Set the budget", onclick: () => ((editing = c.id), draw()) },
        budget == null ? "Set budget" : `${fmt(ctx, r.spentMinor)} of ${fmt(ctx, budget)}`);
    return h("div", { class: `wl-budget${child ? " child" : ""}` },
      chip(categoryGlyph(c.icon), c.color, child ? 22 : 28),
      h("div", { class: "wl-budget-main" },
        h("div", { class: "wl-budget-line" },
          h("button", { class: "wl-budget-name", type: "button", title: "Show these transactions", onclick: () => ctx.go("transactions", { categoryId: c.id, from: monthStart(ctx.month()), to: monthEnd(ctx.month()) }) }, c.name),
          h("span", { class: "spacer" }),
          budget == null && r.spentMinor ? h("span", { class: "wl-budget-spent" }, `${fmt(ctx, r.spentMinor)} spent`) : null,
          amount),
        budget != null ? meter(budget > 0 ? r.spentMinor / budget : r.spentMinor > 0 ? 2 : 0) : null,
        budget != null ? h("div", { class: "wl-budget-foot" }, status(budget, r.spentMinor)) : null));
  }

  function draw() {
    const cats = ctx.state().categories;
    const byId = new Map(rows.map((r) => [r.categoryId, r]));
    const tops = rows.filter((r) => !categoryOf(ctx, r.categoryId)?.parentId);
    const items: HTMLElement[] = [];
    for (const r of tops) {
      const top = row(r, false);
      if (top) items.push(top);
      for (const child of cats.filter((c) => c.parentId === r.categoryId)) {
        const cr = byId.get(child.id);
        // Sub-categories show when they have a budget or spending of their own.
        if (cr && (cr.budgetMinor != null || cr.spentMinor)) {
          const node = row(cr, true);
          if (node) items.push(node);
        }
      }
    }
    list.replaceChildren(h("header", { class: "wl-card-head" }, h("div", null, h("h3", null, "Categories"), h("p", { class: "wl-card-sub" }, "Click an amount to set a budget; leave it empty to remove one."))), ...items);
    // Totals count budgets at the top level only, so a parent and its child aren't added twice.
    const budgeted = tops.filter((r) => r.budgetMinor != null);
    const totalBudget = budgeted.reduce((s, r) => s + (r.budgetMinor ?? 0), 0)
      + rows.filter((r) => r.budgetMinor != null && categoryOf(ctx, r.categoryId)?.parentId && byId.get(categoryOf(ctx, r.categoryId)!.parentId!)?.budgetMinor == null).reduce((s, r) => s + (r.budgetMinor ?? 0), 0);
    const spentInBudgets = budgeted.reduce((s, r) => s + r.spentMinor, 0);
    const spentAll = tops.reduce((s, r) => s + r.spentMinor, 0);
    summary.replaceChildren(
      h("div", { class: "wl-budget-total" },
        h("div", null, h("span", { class: "wl-stat-label" }, `Spent in ${monthLabel(ctx.month(), false)}`), h("strong", { class: "wl-stat-value" }, fmt(ctx, spentAll))),
        h("div", null, h("span", { class: "wl-stat-label" }, "Budgeted"), h("strong", { class: "wl-stat-value" }, totalBudget ? fmt(ctx, totalBudget) : "—")),
        h("div", null, h("span", { class: "wl-stat-label" }, "Left"), h("strong", { class: `wl-stat-value${totalBudget - spentInBudgets < 0 ? " negative" : ""}` }, totalBudget ? fmt(ctx, totalBudget - spentInBudgets) : "—"))),
      totalBudget ? meter(spentInBudgets / totalBudget) : h("p", { class: "wl-card-sub" }, "No budgets this month yet. Set one per category below, or copy last month's."));
  }

  async function copyLast() {
    const from = addMonths(ctx.month(), -1);
    try {
      const n = await walletApi.copyBudgets(from, ctx.month());
      ctx.toast(n ? `Copied ${n} budget${n === 1 ? "" : "s"} from ${monthLabel(from, false)}` : `${monthLabel(from, false)} has no budgets`);
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  return { id: "budgets" as const, title: "Budgets", el, usesMonth: true, load };
}
