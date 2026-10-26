import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { field, openDialog, textInput } from "../../time/dialog";
import { errorText, walletApi, type Earnings, type ProjectRate } from "../api";
import { fmt, type Ctx } from "../ctx";
import { monthLabel, plain, thisMonth, todayKey } from "../format";

/** "10:15 h". */
export function hoursText(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} h`;
}

/** Sets (or clears) a Time project's hourly rate. */
export function rateDialog(ctx: Ctx, project: string, existing: ProjectRate | null, done?: () => void) {
  const s = ctx.state();
  const rate = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "e.g. 1500", value: existing ? plain(existing.rateMinor, existing.currency) : "", "aria-label": "Rate per hour", "data-autofocus": "" });
  const currency = h("select", { class: "wl-select", "aria-label": "Currency" },
    ...s.currencies.map((c) => h("option", { value: c.code, selected: (existing?.currency ?? s.base) === c.code }, `${c.code} — ${c.name}`)));
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, "Save");
  const dialog = openDialog({
    title: `Hourly rate: ${project}`,
    subtitle: "What an hour tracked on this Time project earns. Leave it empty to remove the rate.",
    icon: "clock",
    tone: "work",
    class: "wl-dialog",
    body: [h("div", { class: "tt-pair" }, field("Per hour", rate), field("Currency", currency))],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save],
    submit: () => void submit(),
  });
  async function submit() {
    dialog.busy(true);
    try {
      await walletApi.setProjectRate(project, rate.value, currency.value);
      ctx.changed();
      done?.();
      dialog.close();
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }
}

/** Records the month's earnings as income into an account in the rates' currency. */
function recordDialog(ctx: Ctx, month: string, e: Earnings) {
  const s = ctx.state();
  const ready = e.rows.filter((r) => r.rate && !r.posted);
  const currencies = [...new Set(ready.map((r) => r.rate!.currency))];
  const accounts = s.accounts.filter((a) => !a.archived && currencies.includes(a.currency));
  const account = h("select", { class: "wl-select", "aria-label": "Into account" }, ...accounts.map((a) => h("option", { value: a.id }, `${a.name} (${a.currency})`)));
  const incomes = s.categories.filter((c) => c.kind === "income" && !c.archived);
  const category = h("select", { class: "wl-select", "aria-label": "Category" }, h("option", { value: "" }, "Uncategorised"),
    ...incomes.map((c) => h("option", { value: c.id, selected: c.name === "Freelance" }, c.name)));
  const list = h("div", { class: "wl-earn-list" });
  const drawList = () => {
    const code = accounts.find((a) => a.id === account.value)?.currency;
    list.replaceChildren(...ready.filter((r) => r.rate!.currency === code).map((r) => h("div", { class: "wl-earn" },
      h("span", { class: "wl-earn-name" }, r.project), h("span", { class: "wl-card-sub" }, hoursText(r.minutes)), h("span", { class: "spacer" }),
      h("strong", null, fmt(ctx, r.amountMinor ?? 0, r.rate!.currency)))));
  };
  account.addEventListener("change", drawList);
  drawList();
  const save = h("button", { class: "btn primary", type: "button", disabled: !accounts.length, onclick: () => void submit() }, "Record as Income");
  const dialog = openDialog({
    title: `Earnings for ${monthLabel(month)}`,
    subtitle: `One income transaction per project, dated ${month === thisMonth() ? "today" : "the month's last day"}. A month is recorded once.`,
    icon: "briefcase",
    tone: "work",
    class: "wl-dialog",
    body: [accounts.length ? null : h("p", { class: "tt-hint" }, `Add an account in ${currencies.join(" or ")} first.`), h("div", { class: "tt-pair" }, field("Into", account), field("Category", category)), list],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save],
    submit: () => void submit(),
  });
  async function submit() {
    dialog.busy(true);
    try {
      const n = await walletApi.postEarnings(month, account.value, category.value || null, todayKey());
      ctx.toast(`Recorded ${n} project${n === 1 ? "" : "s"} as income`);
      ctx.changed();
      dialog.close();
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }
}

/** Overview's card: hours tracked in Time this month per project, × their rates. */
export function earningsCard(ctx: Ctx, month: string, e: Earnings): HTMLElement {
  const total = e.rows.reduce((s, r) => s + (r.baseMinor ?? 0), 0);
  const unposted = e.rows.some((r) => r.rate && !r.posted && (r.amountMinor ?? 0) > 0);
  return h("section", { class: "wl-card" },
    h("header", { class: "wl-card-head" },
      h("div", null, h("h3", null, "Earnings"), h("p", { class: "wl-card-sub" }, `Hours tracked in Time × your rates${total ? ` · ${fmt(ctx, total)}` : ""}`)),
      h("span", { class: "spacer" }),
      unposted ? h("button", { class: "btn small", type: "button", onclick: () => recordDialog(ctx, month, e) }, icon("plus", 13), "Record as Income") : null),
    e.rows.length
      ? h("div", { class: "wl-earn-list" }, ...e.rows.map((r) => h("div", { class: "wl-earn" },
        h("span", { class: "wl-earn-name" }, r.project),
        h("span", { class: "wl-card-sub" }, hoursText(r.minutes)),
        h("span", { class: "spacer" }),
        r.rate
          ? h("button", { class: "text-btn", type: "button", title: `${fmt(ctx, r.rate.rateMinor, r.rate.currency)} an hour: change it`, onclick: () => rateDialog(ctx, r.project, r.rate) }, fmt(ctx, r.amountMinor ?? 0, r.rate.currency))
          : h("button", { class: "text-btn", type: "button", onclick: () => rateDialog(ctx, r.project, null) }, "Set a rate"),
        r.posted ? h("span", { class: "wl-pill good", title: "Recorded as income" }, icon("check", 11), "Recorded") : null)))
      : h("p", { class: "wl-chart-empty" }, `No project time tracked in ${monthLabel(month, false)} yet.`));
}
