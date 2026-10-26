import { h } from "../../../ui/dom";
import { errorText, walletApi, type CategorySpend, type MonthTotals } from "../api";
import { categoryName, categoryOf, fmt, type Ctx } from "../ctx";
import { addMonths, compact, monthEnd, monthLabel, monthStart, shortMonth, thisMonth } from "../format";
import { chartCard, columns, hbars, line } from "../charts";
import { categoryGlyph } from "../sheets";

type Span = "3" | "6" | "12" | "year" | "last-year";
const SPANS: [Span, string][] = [["3", "Last 3 months"], ["6", "Last 6 months"], ["12", "Last 12 months"], ["year", "This year"], ["last-year", "Last year"]];

/** The months a span covers, oldest first. */
function spanMonths(span: Span): string[] {
  const now = thisMonth();
  const year = Number(now.slice(0, 4));
  const [first, last] = span === "year" ? [`${year}-01`, now] : span === "last-year" ? [`${year - 1}-01`, `${year - 1}-12`] : [addMonths(now, -(Number(span) - 1)), now];
  const out: string[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * Where the money went over a span: spending by category, income against spending month by
 * month, and net worth at each month's end. One span filter scopes all three; each chart has a
 * table view.
 */
export function reportsView(ctx: Ctx) {
  let span: Span = "12";
  let months: MonthTotals[] = [];
  let spend: CategorySpend[] = [];
  const spanButtons = SPANS.map(([id, label]) => h("button", { type: "button", onclick: () => ((span = id), void load()) }, label));
  const filters = h("div", { class: "wl-filters" }, h("div", { class: "segmented" }, ...spanButtons));
  const body = h("div", { class: "wl-reports" });
  const el = h("div", { class: "wl-view wl-reports-view" }, filters, body);

  async function load() {
    const list = spanMonths(span);
    body.classList.add("refreshing");
    try {
      [months, spend] = await Promise.all([
        walletApi.months(list[list.length - 1], list.length),
        walletApi.byCategory(monthStart(list[0]), monthEnd(list[list.length - 1])),
      ]);
    } catch (err) {
      ctx.toast(errorText(err));
    }
    body.classList.remove("refreshing");
    draw();
  }

  function draw() {
    spanButtons.forEach((b, i) => b.classList.toggle("active", SPANS[i][0] === span));
    const hidden = ctx.hidden();
    const money = (v: number) => fmt(ctx, v);
    const axis = (v: number) => compact(v, ctx.state().base, hidden);
    const label = SPANS.find(([id]) => id === span)?.[1] ?? "";
    const income = months.reduce((s, m) => s + m.incomeMinor, 0);
    const spending = months.reduce((s, m) => s + m.spendingMinor, 0);
    const avg = months.length ? Math.round(spending / months.length) : 0;
    const tile = (name: string, value: string) => h("section", { class: "wl-card wl-tile" }, h("span", { class: "wl-stat-label" }, name), h("strong", { class: "wl-stat-value" }, value));
    const tiles = h("div", { class: "wl-tiles wl-tiles-4" },
      tile("Income", money(income)), tile("Spending", money(spending)),
      tile("Kept", fmt(ctx, income - spending, undefined, { signed: true })), tile("Spending a month", money(avg)));

    const first = months[0]?.month ?? thisMonth();
    const last = months[months.length - 1]?.month ?? thisMonth();
    const byCat = chartCard("Spending by category", label, hbars(spend.map((c) => {
      const cat = categoryOf(ctx, c.categoryId);
      return {
        label: cat?.name ?? "Uncategorised", value: c.spentMinor, text: money(c.spentMinor), glyph: categoryGlyph(cat?.icon), chipColor: cat?.color,
        detail: c.children.map((k) => ({ label: categoryName(ctx, k.categoryId), text: money(k.spentMinor) })),
        onClick: () => ctx.go("transactions", { categoryId: c.categoryId, from: monthStart(first), to: monthEnd(last) }),
      };
    })), {
      head: ["Category", "Spent", "Share"],
      rows: spend.flatMap((c) => [
        [categoryName(ctx, c.categoryId), money(c.spentMinor), spending ? `${Math.round((c.spentMinor / spending) * 100)}%` : "—"],
        ...c.children.map((k) => [` ${categoryName(ctx, k.categoryId)}`, money(k.spentMinor), spending ? `${Math.round((k.spentMinor / spending) * 100)}%` : "—"]),
      ]),
    });

    const labels = months.map((m) => shortMonth(m.month));
    const titles = months.map((m) => monthLabel(m.month));
    const flows = chartCard("Income and spending", "Each month", columns(labels, titles, [
      { name: "Income", color: "var(--viz-1)", values: months.map((m) => m.incomeMinor) },
      { name: "Spending", color: "var(--viz-2)", values: months.map((m) => m.spendingMinor) },
    ], money, axis), {
      head: ["Month", "Income", "Spending", "Kept"],
      rows: months.map((m) => [monthLabel(m.month), money(m.incomeMinor), money(m.spendingMinor), fmt(ctx, m.incomeMinor - m.spendingMinor, undefined, { signed: true })]),
    });

    const worth = chartCard("Net worth", "At the end of each month, in all accounts", line(labels, titles, months.map((m) => m.netWorthMinor), "Net worth", money, axis), {
      head: ["Month", "Net worth"],
      rows: months.map((m) => [monthLabel(m.month), money(m.netWorthMinor)]),
    });
    body.replaceChildren(tiles, h("div", { class: "wl-report-grid" }, byCat, h("div", { class: "wl-report-stack" }, flows, worth)));
  }

  return { id: "reports" as const, title: "Reports", el, usesMonth: false, load };
}
