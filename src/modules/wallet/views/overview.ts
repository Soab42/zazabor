import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { errorText, walletApi, type BudgetRow, type CategorySpend, type MonthTotals, type Tx } from "../api";
import { ACCOUNT_KIND_ICON, accountOf, categoryName, categoryOf, fmt, type Ctx } from "../ctx";
import { addMonths, dayLabel, monthEnd, monthLabel, monthStart, shortDate } from "../format";
import { chartCard, hbars, meter } from "../charts";
import { categoryGlyph, chip } from "../sheets";

/** A signed change against last month, coloured by whether that direction is good. */
function delta(now: number, before: number, upIsGood: boolean, format: (v: number) => string): HTMLElement | null {
  if (!before && !now) return null;
  const diff = now - before;
  if (!diff) return h("span", { class: "wl-delta" }, "Same as last month");
  const good = diff > 0 === upIsGood;
  return h("span", { class: `wl-delta ${good ? "good" : "bad"}` }, icon(diff > 0 ? "trendUp" : "trendDown", 13), `${format(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than last month`);
}

/**
 * The month at a glance: the total balance (the one big number), the month's income, spending
 * and what was kept, spending by category, the budgets closest to their limit, the accounts and
 * the latest transactions.
 */
export function overviewView(ctx: Ctx) {
  let months: MonthTotals[] = [];
  let spend: CategorySpend[] = [];
  let budgets: BudgetRow[] = [];
  let recent: Tx[] = [];
  const el = h("div", { class: "wl-view wl-overview" });

  async function load() {
    const month = ctx.month();
    el.classList.add("refreshing");
    try {
      [months, spend, budgets, recent] = await Promise.all([
        walletApi.months(month, 2),
        walletApi.byCategory(monthStart(month), monthEnd(month)),
        walletApi.budgets(month),
        walletApi.list({ limit: 8 }).then((p) => p.items.filter((t) => !(t.kind === "transfer" && t.amountMinor > 0))),
      ]);
    } catch (err) {
      ctx.toast(errorText(err));
    }
    el.classList.remove("refreshing");
    draw();
  }

  function draw() {
    const s = ctx.state();
    const month = ctx.month();
    const now = months[1] ?? { month, incomeMinor: 0, spendingMinor: 0, netWorthMinor: 0 };
    const before = months[0] ?? { month: addMonths(month, -1), incomeMinor: 0, spendingMinor: 0, netWorthMinor: 0 };
    const live = s.accounts.filter((a) => !a.archived);
    const balance = live.reduce((t, a) => t + (a.balanceBaseMinor ?? 0), 0);
    const money = (v: number) => fmt(ctx, v);
    const kept = now.incomeMinor - now.spendingMinor;
    const rate = now.incomeMinor > 0 && !ctx.hidden() ? Math.round((kept / now.incomeMinor) * 100) : null;

    const hero = h("section", { class: "wl-card wl-hero-card" },
      h("span", { class: "wl-stat-label" }, "Total balance"),
      h("strong", { class: "wl-hero" }, money(balance)),
      h("span", { class: "wl-card-sub" }, `Across ${live.length} account${live.length === 1 ? "" : "s"}, in ${s.base}`));
    const tile = (label: string, value: string, d: HTMLElement | null, extra: string | null = null) =>
      h("section", { class: "wl-card wl-tile" }, h("span", { class: "wl-stat-label" }, label), h("strong", { class: "wl-stat-value" }, value), d, extra ? h("span", { class: "wl-card-sub" }, extra) : null);
    const tiles = h("div", { class: "wl-tiles" },
      tile(`Income in ${monthLabel(month, false)}`, money(now.incomeMinor), delta(now.incomeMinor, before.incomeMinor, true, money)),
      tile("Spending", money(now.spendingMinor), delta(now.spendingMinor, before.spendingMinor, false, money)),
      tile("Kept", fmt(ctx, kept, undefined, { signed: true }), delta(kept, before.incomeMinor - before.spendingMinor, true, money), rate != null ? `${rate}% of income` : null));

    const top = spend.slice(0, 6);
    const spendCard = chartCard("Spending by category", monthLabel(month), hbars(top.map((c) => {
      const cat = categoryOf(ctx, c.categoryId);
      return {
        label: cat?.name ?? "Uncategorised", value: c.spentMinor, text: money(c.spentMinor), glyph: categoryGlyph(cat?.icon), chipColor: cat?.color,
        detail: c.children.map((k) => ({ label: categoryName(ctx, k.categoryId), text: money(k.spentMinor) })),
        onClick: () => ctx.go("transactions", { categoryId: c.categoryId, from: monthStart(month), to: monthEnd(month) }),
      };
    })), { head: ["Category", "Spent"], rows: top.map((c) => [categoryName(ctx, c.categoryId), money(c.spentMinor)]) },
    spend.length > 6 ? h("button", { class: "text-btn", type: "button", onclick: () => ctx.go("reports") }, "All") : null);

    const withBudget = budgets.filter((b) => b.budgetMinor != null && !categoryOf(ctx, b.categoryId)?.parentId)
      .sort((a, b) => b.spentMinor / Math.max(1, b.budgetMinor!) - a.spentMinor / Math.max(1, a.budgetMinor!)).slice(0, 5);
    const budgetCard = h("section", { class: "wl-card" },
      h("header", { class: "wl-card-head" }, h("div", null, h("h3", null, "Budgets"), h("p", { class: "wl-card-sub" }, "Closest to the limit first")), h("span", { class: "spacer" }),
        h("button", { class: "text-btn", type: "button", onclick: () => ctx.go("budgets") }, withBudget.length ? "All" : "Set up")),
      withBudget.length
        ? h("div", { class: "wl-mini-budgets" }, ...withBudget.map((b) => {
          const cat = categoryOf(ctx, b.categoryId);
          const ratio = b.budgetMinor ? b.spentMinor / b.budgetMinor : 2;
          return h("div", { class: "wl-mini-budget" },
            h("div", { class: "wl-budget-line" }, chip(categoryGlyph(cat?.icon), cat?.color ?? "gray", 22), h("span", { class: "wl-mini-name" }, cat?.name ?? ""), h("span", { class: "spacer" }),
              ratio > 1
                ? h("span", { class: "wl-mini-amount over" }, icon("info", 12), `${money(b.spentMinor - b.budgetMinor!)} over`)
                : h("span", { class: "wl-mini-amount" }, `${money(b.spentMinor)} of ${money(b.budgetMinor!)}`)),
            meter(ratio));
        }))
        : h("p", { class: "wl-chart-empty" }, "No budgets for this month. Give a category a monthly limit to see how it's going."));

    const accountsCard = h("section", { class: "wl-card" },
      h("header", { class: "wl-card-head" }, h("h3", null, "Accounts"), h("span", { class: "spacer" }), h("button", { class: "text-btn", type: "button", onclick: () => ctx.go("accounts") }, "All")),
      h("div", { class: "wl-mini-accounts" }, ...live.map((a) => h("button", { class: "wl-mini-account", type: "button", onclick: () => ctx.go("transactions", { accountId: a.id }) },
        h("span", { class: `wl-chip wl-c-${a.color}`, style: { width: "26px", height: "26px" } }, icon(ACCOUNT_KIND_ICON[a.kind], 14)),
        h("span", { class: "wl-mini-name" }, a.name), h("span", { class: "spacer" }),
        h("span", { class: `wl-mini-amount${a.balanceMinor < 0 ? " negative" : ""}` }, fmt(ctx, a.balanceMinor, a.currency))))));

    const recentCard = h("section", { class: "wl-card wl-recent" },
      h("header", { class: "wl-card-head" }, h("h3", null, "Latest"), h("span", { class: "spacer" }), h("button", { class: "text-btn", type: "button", onclick: () => ctx.go("transactions") }, "All")),
      recent.length
        ? h("div", { class: "wl-mini-txs" }, ...recent.map((t) => {
          const cat = categoryOf(ctx, t.categoryId);
          const transfer = t.kind === "transfer";
          const label = transfer ? `${accountOf(ctx, t.accountId)?.name ?? ""} → ${accountOf(ctx, t.counterAccountId)?.name ?? ""}` : t.payee || categoryName(ctx, t.categoryId);
          return h("button", { class: "wl-mini-tx", type: "button", onclick: () => ctx.openTx(t) },
            transfer ? chip("transfer", "gray", 26) : chip(categoryGlyph(cat?.icon), cat?.color ?? "gray", 26),
            h("span", { class: "wl-mini-text" }, h("span", { class: "wl-mini-name" }, label), h("span", { class: "wl-card-sub" }, dayLabel(t.date) === "Today" || dayLabel(t.date) === "Yesterday" ? dayLabel(t.date) : shortDate(t.date))),
            h("span", { class: "spacer" }),
            h("span", { class: `wl-mini-amount ${t.kind === "income" ? "in" : ""}` }, transfer ? fmt(ctx, -t.amountMinor, t.currency) : fmt(ctx, t.amountMinor, t.currency, { signed: true })));
        }))
        : h("p", { class: "wl-chart-empty" }, "Nothing yet. Try Quick add above: “250 lunch bkash”."));

    el.replaceChildren(h("div", { class: "wl-overview-top" }, hero, tiles), h("div", { class: "wl-overview-grid" }, spendCard, budgetCard, accountsCard, recentCard));
  }

  return { id: "overview" as const, title: "Overview", el, usesMonth: true, load };
}
