import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { confirmDialog, field, openDialog, textArea, textInput, type Dialog } from "../../time/dialog";
import { DateTimeField } from "../../time/pickers";
import { errorText, walletApi, type Plan, type PlanDetail, type PlanInput, type PlanRow } from "../api";
import { accountOf, fmt, type Ctx } from "../ctx";
import { dateKey, parseDate, plain, shortDate, symbolOf, todayKey } from "../format";
import { chip, detailsEditor, detailsLine, swatches } from "../sheets";
import { fdrCard, fdrSheet, fdrTable } from "./fdr";
import type { FdrDetail } from "../api";

const percent = (bp: number) => `${(bp / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

const METHOD_LABEL: Record<Plan["method"], string> = {
  daily: "by the day on what's owed",
  reducing: "by the month on what's owed",
  flat: "flat on the amount borrowed",
};

/** "3", "3–4", or "Part" for a part payment. */
function numbers(r: Pick<PlanRow, "no" | "count">): string {
  if (r.no == null) return "Part";
  return r.count > 1 ? `${r.no}–${r.no + r.count - 1}` : String(r.no);
}

/**
 * DPS and loan accounts: their terms, how far along they are, and the table, worked out from
 * what was really paid (each payment on its own day and of its own amount) as the bank's
 * statement is, then the installments still to come. Payments are transfers from the account
 * it's paid from (a loan's interest goes as spending); any of them can be changed here.
 */
export function plansView(ctx: Ctx) {
  let plans: Plan[] = [];
  let fdrs: FdrDetail[] = [];
  let selected: string | null = null;
  let detail: PlanDetail | null = null;
  const actions = h("div", { class: "wl-view-actions" },
    h("span", { class: "spacer" }),
    h("button", { class: "btn small", type: "button", onclick: () => fdrSheet(ctx, null) }, icon("plus", 14), "New FDR"),
    h("button", { class: "btn small", type: "button", onclick: () => planSheet(ctx, null, "dps") }, icon("plus", 14), "New DPS"),
    h("button", { class: "btn small primary", type: "button", onclick: () => planSheet(ctx, null, "loan") }, icon("plus", 14), "New Loan"));
  const summary = h("div", { class: "wl-tiles" });
  const list = h("div", { class: "wl-plan-list" });
  const tableCard = h("section", { class: "wl-card wl-plan-table" });
  const el = h("div", { class: "wl-view wl-plans" }, actions, summary, list, tableCard);

  async function load() {
    try {
      [plans, fdrs] = await Promise.all([walletApi.plans(todayKey()), walletApi.fdrs(todayKey())]);
      const fdr = fdrs.find((f) => f.fdr.id === selected || f.fdr.accountId === selected);
      const plan = fdr ? undefined : plans.find((p) => p.id === selected || p.accountId === selected) ?? plans[0];
      selected = fdr?.fdr.id ?? plan?.id ?? fdrs[0]?.fdr.id ?? null;
      detail = plan ? await walletApi.plan(plan.id, todayKey()) : null;
    } catch (err) {
      ctx.toast(errorText(err));
    }
    draw();
  }

  function card(p: Plan): HTMLElement {
    const loan = p.kind === "loan";
    const progress = p.installments ? p.paid / p.installments : 0;
    const more = h("button", { class: "icon-btn small wl-card-more", type: "button", title: "More", "aria-label": `More for ${p.name}` }, icon("more", 16));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      menu(p, r.left, r.bottom + 4);
    });
    const c = h("div", { class: `wl-account wl-plan wl-c-${p.color}${p.id === selected ? " selected" : ""}`, role: "button", tabindex: 0, "aria-pressed": String(p.id === selected),
      onclick: () => void pick(p.id) },
      h("div", { class: "wl-account-top" },
        chip(loan ? "bank" : "target", p.color, 34),
        h("div", { class: "wl-account-name" }, h("strong", null, p.name), h("span", null, `${loan ? "Loan" : "DPS"} · ${percent(p.rateBp)} · ${p.months} months`))),
      (() => {
        const a = accountOf(ctx, p.accountId);
        const line = a ? detailsLine(a) : "";
        return line ? h("div", { class: "wl-account-details" }, line) : null;
      })(),
      h("div", { class: "wl-account-balance" }, fmt(ctx, p.outstandingMinor, p.currency)),
      h("div", { class: "wl-account-base" }, loan
        ? `still owed${p.unpaidInterestMinor ? ` · ${fmt(ctx, p.unpaidInterestMinor, p.currency)} interest unpaid` : ""}`
        : `worth now · ${fmt(ctx, p.paidMinor, p.currency)} deposited · ${fmt(ctx, p.totalMinor, p.currency)} at maturity`),
      h("span", { class: "wl-meter", "aria-hidden": "true" }, h("span", { class: "wl-meter-fill", style: { width: `${Math.round(progress * 100)}%` } })),
      h("div", { class: "wl-account-meta" }, `${p.paid} of ${p.installments} paid`,
        p.nextDate ? ` · next ${shortDate(p.nextDate)}` : " · done",
        p.overdue ? h("span", { class: "wl-late" }, ` · ${p.overdue} due`) : null,
        p.inTotal ? null : h("span", { class: "wl-muted" }, " · not in total")));
    c.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === c) {
        e.preventDefault();
        c.click();
      }
    });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu(p, e.clientX, e.clientY);
    });
    c.append(more);
    return c;
  }

  function menu(p: Plan, x: number, y: number) {
    openMenu(x, y, [
      { label: "Edit…", icon: "pencil", action: () => planSheet(ctx, p, p.kind) },
      { label: "Add a payment…", icon: "plus", action: () => void withDetail(p, (d) => paymentSheet(ctx, d, null, null)) },
      { label: "Show its transactions", icon: "list", action: () => ctx.go("transactions", { accountId: p.accountId }) },
      "separator",
      { label: "Delete…", icon: "trash", danger: true, action: () => void remove(p) },
    ]);
  }

  async function withDetail(p: Plan, run: (d: PlanDetail) => void) {
    try {
      run(detail?.plan.id === p.id ? detail : await walletApi.plan(p.id, todayKey()));
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  async function pick(id: string) {
    selected = id;
    try {
      detail = await walletApi.plan(id, todayKey());
    } catch (err) {
      ctx.toast(errorText(err));
    }
    draw();
  }

  async function remove(p: Plan) {
    const yes = await confirmDialog({
      title: `Delete ${p.name}?`,
      text: p.paidMinor || p.disburseTo
        ? "Its table goes. What it already posted stays, as ordinary transfers, and so does its account."
        : "Its table and its account go. Nothing was posted for it yet.",
      confirm: "Delete", danger: true, icon: "trash", tone: "idle",
    });
    if (!yes) return;
    try {
      await walletApi.deletePlan(p.id);
      ctx.toast(`${p.name} deleted`);
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  function drawTable() {
    const fdr = fdrs.find((f) => f.fdr.id === selected);
    if (fdr) {
      tableCard.hidden = false;
      tableCard.replaceChildren(...fdrTable(ctx, fdr));
      return;
    }
    if (!detail || detail.plan.id !== selected) {
      tableCard.hidden = true;
      return;
    }
    tableCard.hidden = false;
    const d = detail;
    const p = d.plan;
    const loan = p.kind === "loan";
    const carries = loan && d.rows.some((r) => r.unpaidInterestMinor !== 0);
    const head = loan
      ? ["#", "Date", "Paid", "Principal", "Interest", "Still owed", ...(carries ? ["Unpaid interest"] : []), ""]
      : ["#", "Date", "Deposit", "Deposited", "Interest", "Value", ""];
    const numeric = new Set(loan ? [2, 3, 4, 5, ...(carries ? [6] : [])] : [2, 3, 4, 5]);
    const rows = d.rows.map((r) => {
      const projected = r.kind !== "payment" && r.kind !== "before";
      const action = r.kind === "payment"
        ? h("button", { class: "icon-btn small", type: "button", title: "Change this payment", "aria-label": "Change this payment", onclick: (e: Event) => (e.stopPropagation(), paymentSheet(ctx, d, r, null)) }, icon("pencil", 13))
        : r.kind === "before" ? h("span", { class: "wl-card-sub" }, "Paid before")
          : r.kind === "upcoming" && r.no !== p.nextNo ? null
          : h("button", { class: `btn small${r.kind === "due" || r.kind === "missed" ? " primary" : ""}`, type: "button", onclick: (e: Event) => (e.stopPropagation(), paymentSheet(ctx, d, null, r)) }, icon("check", 13), "Pay");
      const blank = r.kind === "missed";
      const money = (n: number) => (blank ? "—" : fmt(ctx, n, p.currency));
      const tr = h("tr", { class: `wl-plan-row ${r.kind}${projected ? " projected" : ""}`, title: r.note || (r.kind === "missed" ? "Not paid: its date has passed" : projected ? "Projected from what's owed now" : "") },
        h("td", { class: "num" }, numbers(r)),
        h("td", null, shortDate(r.date),
          r.kind === "payment" && !r.posted ? h("span", { class: "wl-plan-from", title: "Paid before Wallet: kept for the table, no money moved here" }, " · recorded")
            : r.fromAccount ? h("span", { class: "wl-plan-from" }, ` · from ${accountOf(ctx, r.fromAccount)?.name ?? "?"}`) : null),
        h("td", { class: "num" }, fmt(ctx, r.paymentMinor, p.currency)),
        h("td", { class: "num" }, money(r.principalMinor)),
        h("td", { class: "num" }, money(r.interestMinor), r.interestTyped != null ? h("span", { class: "wl-plan-typed", title: "As the bank's statement has it" }, " ✎") : null),
        h("td", { class: "num" }, money(r.balanceMinor)),
        ...(carries ? [h("td", { class: `num${r.unpaidInterestMinor ? " wl-plan-unpaid" : ""}` }, r.unpaidInterestMinor ? fmt(ctx, -r.unpaidInterestMinor, p.currency) : blank ? "—" : "0")] : []),
        h("td", { class: "wl-plan-state" }, action));
      if (r.kind === "payment") tr.addEventListener("click", () => paymentSheet(ctx, d, r, null));
      return tr;
    });
    const from = accountOf(ctx, p.payFrom);
    const to = accountOf(ctx, p.disburseTo);
    tableCard.replaceChildren(
      h("header", { class: "wl-card-head" },
        h("div", null,
          h("h3", null, `${p.name}: ${loan ? "repayment" : "deposit"} table`),
          h("p", { class: "wl-card-sub" }, [
            loan ? `${fmt(ctx, p.amountMinor, p.currency)} at ${percent(p.rateBp)}, ${METHOD_LABEL[p.method]}` : `${fmt(ctx, p.amountMinor, p.currency)} a month at ${percent(p.rateBp)}`,
            loan ? `lent ${shortDate(p.disburseDate)}${to ? ` into ${to.name}` : ""}` : null,
            `${shortDate(p.startDate)} to ${shortDate(p.endDate)}`,
            `paid from ${from?.name ?? "a missing account"}, ${p.autoPost ? "by itself on the day" : "when you add it"}`,
          ].filter(Boolean).join(" · "))),
        h("span", { class: "spacer" }),
        h("button", { class: "btn small", type: "button", title: "Copy the statement's rows from the bank's page or a spreadsheet and paste them here", onclick: () => statementSheet(ctx, d) }, icon("paste", 13), "Paste Statement"),
        h("button", { class: "btn small", type: "button", onclick: () => paymentSheet(ctx, d, null, null) }, icon("plus", 13), "Add Payment"),
        h("button", { class: "btn small", type: "button", onclick: () => planSheet(ctx, p, p.kind) }, icon("pencil", 13), "Edit")),
      h("div", { class: "wl-tiles wl-tiles-4 wl-plan-tiles" },
        tile(loan ? "Installment" : "Deposit", fmt(ctx, p.paymentMinor, p.currency), "each month"),
        loan
          ? tile("Interest", fmt(ctx, p.interestPaidMinor, p.currency), `paid so far · ${fmt(ctx, p.interestMinor, p.currency)} in all, as projected`)
          : tile("Interest at maturity", fmt(ctx, p.interestMinor, p.currency), p.maturityTyped ? "as the bank states it" : "estimated"),
        tile("Paid", `${p.paid} of ${p.installments}`, p.overdue ? `${p.overdue} due now` : p.nextDate ? `next ${shortDate(p.nextDate)}` : "all paid"),
        tile(loan ? "Still owed" : "Value now", fmt(ctx, p.outstandingMinor, p.currency),
          loan ? (p.unpaidInterestMinor ? `and ${fmt(ctx, p.unpaidInterestMinor, p.currency)} interest unpaid` : `${fmt(ctx, p.paidMinor, p.currency)} paid so far`) : `${fmt(ctx, p.paidMinor, p.currency)} deposited`)),
      h("div", { class: "wl-table-scroll" },
        h("table", { class: "wl-table" },
          h("thead", null, h("tr", null, ...head.map((t, i) => h("th", { class: numeric.has(i) ? "num" : "" }, t)))),
          h("tbody", null, ...rows))),
      h("p", { class: "wl-card-sub wl-plan-foot" }, loan
        ? "Each payment pays the interest due first, then what's owed. Pick a payment to change its day, amount, the installments it pays or the interest the bank charged; rows after it follow. Faded rows are projected."
        : "Pick a deposit to change it. Faded rows are projected; the interest is an estimate until maturity."));
  }

  function tile(label: string, value: string, sub: string) {
    return h("div", { class: "wl-tile" }, h("span", { class: "wl-stat-label" }, label), h("strong", { class: "wl-stat-value" }, value), h("span", { class: "wl-card-sub" }, sub));
  }

  function draw() {
    const loans = plans.filter((p) => p.kind === "loan");
    const dps = plans.filter((p) => p.kind === "dps");
    const owed = loans.reduce((s, p) => s + p.outstandingMinor, 0);
    const saved = dps.reduce((s, p) => s + p.outstandingMinor, 0);
    const monthly = plans.filter((p) => p.nextDate).reduce((s, p) => s + p.paymentMinor, 0);
    const cardTile = (label: string, value: string, sub: string) => h("section", { class: "wl-card wl-tile" }, h("span", { class: "wl-stat-label" }, label), h("strong", { class: "wl-stat-value" }, value), h("span", { class: "wl-card-sub" }, sub));
    const any = plans.length + fdrs.length > 0;
    const inFdr = fdrs.reduce((s, f) => s + f.fdr.balanceMinor, 0);
    summary.hidden = !any;
    actions.hidden = !any;
    summary.classList.toggle("wl-tiles-4", fdrs.length > 0);
    summary.replaceChildren(
      cardTile("Loans owed", fmt(ctx, owed), `${loans.length} loan${loans.length === 1 ? "" : "s"}`),
      cardTile("Saved in DPS", fmt(ctx, saved), `${dps.length} DPS`),
      ...(fdrs.length ? [cardTile("In FDRs", fmt(ctx, inFdr), `${fdrs.length} FDR${fdrs.length === 1 ? "" : "s"}`)] : []),
      cardTile("Installments a month", fmt(ctx, monthly), "loans and DPS still running"));
    const fdrMenu = (d: FdrDetail) => (x: number, y: number) => openMenu(x, y, [
      { label: "Edit…", icon: "pencil", action: () => fdrSheet(ctx, d.fdr) },
      { label: "Show its transactions", icon: "list", action: () => ctx.go("transactions", { accountId: d.fdr.accountId }) },
    ]);
    list.replaceChildren(...(any
      ? [h("div", { class: "wl-account-grid" }, ...plans.map(card), ...fdrs.map((d) => fdrCard(ctx, d, d.fdr.id === selected, () => ((selected = d.fdr.id), draw()), fdrMenu(d))))]
      : [h("div", { class: "wl-empty" },
        h("div", { class: "wl-empty-tile glass" }, icon("bank", 26)),
        h("h2", null, "No loans, DPS or FDRs yet"),
        h("p", null, "Add a loan or a DPS with its amount, rate and months. Wallet works out the table from what you pay, like the bank's statement, and can pay each installment from your bank account on the day. An FDR posts its interest by itself."),
        h("div", { class: "wl-inline" },
          h("button", { class: "btn", type: "button", onclick: () => fdrSheet(ctx, null) }, icon("plus", 15), "New FDR"),
          h("button", { class: "btn", type: "button", onclick: () => planSheet(ctx, null, "dps") }, icon("plus", 15), "New DPS"),
          h("button", { class: "btn primary", type: "button", onclick: () => planSheet(ctx, null, "loan") }, icon("plus", 15), "New Loan")))]));
    drawTable();
  }

  return {
    id: "plans" as const,
    title: "Loans, DPS & FDR",
    el,
    usesMonth: false,
    load,
    /** Opens on this plan (by its id or its account's) next time it loads. */
    select(id: string) {
      selected = id;
    },
  };
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

function everydayAccounts(ctx: Ctx, keep: string | null = null) {
  return ctx.state().accounts.filter((a) => (!a.archived || a.id === keep) && a.kind !== "dps" && a.kind !== "loan");
}

function onOff(label: string, hint: string, on: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": label });
  input.checked = on;
  return { input, row: h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, label), h("p", { class: "tt-hint" }, hint)), input) };
}

/**
 * A payment on a DPS or loan: the day, the amount, which installments it pays (one, several, or
 * none for a part payment), the account it came from, and, for a loan, the interest the bank
 * charged when its statement differs. `existing` changes a payment; `due` pays a projected row.
 */
export function paymentSheet(ctx: Ctx, d: PlanDetail, existing: PlanRow | null, due: PlanRow | null) {
  const p = d.plan;
  const loan = p.kind === "loan";
  const today = todayKey();
  const open = d.rows.filter((r) => (r.kind === "missed" || r.kind === "due" || r.kind === "upcoming") && r.no != null);
  const suggested = due ?? open[0] ?? null;
  const date = new DateTimeField({
    value: parseDate(existing?.date ?? (suggested && suggested.date <= today ? suggested.date : today)).getTime(),
    placeholder: "Pick a day", label: "Paid on", dateOnly: true, future: true, host: () => dialog.overlay,
  });
  const symbol = h("span", { class: "wl-amount-symbol" }, symbolOf(p.currency).trim());
  const amount = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "0", "aria-label": "Amount", "data-autofocus": "",
    value: existing ? plain(existing.paymentMinor, p.currency) : suggested ? plain(suggested.paymentMinor, p.currency) : "" });
  // Which installments: the open ones, and the ones this payment already pays.
  const choices = new Map<number, string>();
  if (existing?.no != null) choices.set(existing.no, shortDate(existing.date));
  for (const r of open) if (r.no != null && !choices.has(r.no)) choices.set(r.no, `${shortDate(r.date)}${r.kind === "missed" ? " · missed" : r.kind === "due" ? " · due" : ""}`);
  const pays = h("select", { class: "wl-select", "aria-label": "Pays" },
    h("option", { value: "" }, "A part payment (no installment)"),
    ...[...choices.entries()].sort((a, b) => a[0] - b[0]).map(([no, when]) => h("option", { value: String(no) }, `Installment ${no} · ${when}`)));
  pays.value = existing ? (existing.no != null ? String(existing.no) : "") : suggested?.no != null ? String(suggested.no) : "";
  const count = textInput({ class: "tt-input wl-every", inputmode: "numeric", value: String(existing?.count ?? 1), "aria-label": "Installments" });
  const countField = field("Installments it pays", h("div", { class: "wl-inline" }, count, h("span", { class: "tt-hint" }, "from that one: 2 for two months at once")));
  const accounts = everydayAccounts(ctx, existing?.fromAccount ?? p.payFrom);
  const from = h("select", { class: "wl-select", "aria-label": "Paid from" },
    ...accounts.map((a) => h("option", { value: a.id, selected: a.id === (existing?.fromAccount ?? p.payFrom) }, a.name)));
  const interest = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "worked out", "aria-label": "Interest charged",
    value: existing?.interestTyped != null ? plain(existing.interestTyped, p.currency) : "" });
  const note = textArea({ placeholder: "Anything to remember", "aria-label": "Note", rows: 2 });
  note.value = existing?.note ?? "";
  const moves = onOff("Move the money in Wallet", "On: a transfer from the account it's paid from. Off: it was paid before, outside Wallet, and is only kept for the table.", existing?.posted ?? true);
  const fromField = field("Paid from", from);
  const update = () => {
    countField.hidden = !pays.value;
    fromField.hidden = !moves.input.checked;
  };
  moves.input.addEventListener("change", update);
  pays.addEventListener("change", update);
  update();

  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : "Add Payment");
  const dialog = openDialog({
    title: existing ? `Payment ${numbers(existing)} of ${p.name}` : `Payment on ${p.name}`,
    subtitle: loan
      ? "It pays the interest due first, then what's owed. The rows after it are worked out again."
      : "A deposit into the DPS.",
    icon: loan ? "bank" : "target",
    tone: "work",
    class: "wl-dialog",
    body: [
      h("div", { class: "tt-pair" }, field("Amount", h("div", { class: "wl-amount" }, symbol, amount)), field("Paid on", date.el)),
      field("Pays", pays),
      countField,
      moves.row,
      fromField,
      loan ? field("Interest charged", h("div", { class: "wl-amount" }, h("span", { class: "wl-amount-symbol" }, symbolOf(p.currency).trim()), interest),
        { optional: true, note: h("span", { class: "tt-hint" }, "as the statement shows, with any unpaid before") }) : null,
      field("Note", note, { optional: true }),
    ],
    foot: [
      existing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null,
      h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save,
    ],
    submit: () => void submit(),
  });

  async function submit() {
    const on = date.get();
    if (on == null) return dialog.error("Pick the day it was paid.");
    if (!amount.value.trim()) return dialog.error("Type the amount paid.");
    const saved = await attempt(dialog, () => walletApi.savePayment({
      id: existing?.paymentId ?? null, planId: p.id, date: dateKey(new Date(on)), amount: amount.value,
      no: pays.value ? Number(pays.value) : null, count: Math.max(1, Number(count.value) || 1),
      interest: loan ? interest.value : null, fromAccount: from.value, note: note.value, posted: moves.input.checked,
    }, todayKey()));
    if (!saved) return;
    ctx.toast(existing ? "Payment saved: the table is worked out again" : `Added a payment of ${fmt(ctx, Math.round(Number(amount.value.replace(/,/g, "")) * 100) || 0, p.currency)} to ${p.name}`);
    ctx.changed();
    dialog.close();
  }

  async function del() {
    if (!existing?.paymentId) return;
    const yes = await confirmDialog({ title: "Delete this payment?", text: "Its transfer goes from your accounts, and the rows after it are worked out again.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (yes && (await attempt(dialog, () => walletApi.deletePayment(existing.paymentId!, todayKey()).then(() => true)))) {
      ctx.toast("Payment deleted");
      ctx.changed();
      dialog.close();
    }
  }
}

/**
 * Paste a statement: the bank's rows (copied from its page or a spreadsheet) become the payments
 * already made, recorded without moving money, with the interest the bank charged on each.
 */
export function statementSheet(ctx: Ctx, d: PlanDetail) {
  const p = d.plan;
  const loan = p.kind === "loan";
  const text = textArea({ placeholder: "Date\tDescription\tInst\tDebit\tPrincipal\tInterest\tBalance\n2024-05-08\tLoan Recovery\t1\t11135\t8493.90\t2641.10\t491506.10", "aria-label": "Statement", rows: 10, class: "tt-input wl-statement-text" });
  const byDay = onOff("Interest by the day from here on", "As the statement charges it: on what's still owed, for the actual days. The installments still to come are projected that way.", p.method === "daily" || loan);
  const found = h("div", { class: "wl-plan-preview", "aria-live": "polite" }, h("span", { class: "tt-hint" }, "Paste the rows, with the header line if it has one, then press Read."));
  let ready = false;
  const read = h("button", { class: "btn", type: "button", onclick: () => void look() }, "Read");
  const add = h("button", { class: "btn primary", type: "button", disabled: true, onclick: () => void apply() }, "Add Payments");
  const dialog = openDialog({
    title: `Paste ${p.name}'s statement`,
    subtitle: "Each row becomes a payment already made: kept for the table, with no money moved in Wallet. Rows already here are skipped.",
    icon: "paste",
    tone: "work",
    class: "wl-dialog wl-statement",
    body: [field("Statement rows", text), loan ? byDay.row : null, found],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), read, add],
    submit: () => void (ready ? apply() : look()),
  });
  text.addEventListener("input", () => {
    ready = false;
    add.disabled = true;
  });

  async function look() {
    if (!text.value.trim()) return dialog.error("Paste the statement's rows first.");
    dialog.error("");
    try {
      const r = await walletApi.importStatement(p.id, text.value, byDay.input.checked, false, todayKey());
      ready = r.added > 0;
      add.disabled = !ready;
      add.textContent = r.added ? `Add ${r.added} Payment${r.added === 1 ? "" : "s"}` : "Add Payments";
      const f = (n: number) => fmt(ctx, n, p.currency);
      found.replaceChildren(
        h("div", null, h("span", { class: "wl-stat-label" }, "Payments"), h("strong", null, `${r.added} new`), h("span", { class: "tt-hint" }, r.found > r.added ? `${r.found - r.added} already here` : `${r.found} read`)),
        h("div", null, h("span", { class: "wl-stat-label" }, "From"), h("strong", null, r.first ? shortDate(r.first) : "—"), h("span", { class: "tt-hint" }, r.last ? `to ${shortDate(r.last)}` : "")),
        h("div", null, h("span", { class: "wl-stat-label" }, "Lent on"), h("strong", null, r.disburseDate ? shortDate(r.disburseDate) : shortDate(p.disburseDate)), h("span", { class: "tt-hint" }, r.disburseDate ? "from the statement" : "as set")),
        h("div", null, h("span", { class: "wl-stat-label" }, loan ? "Still owed after" : "Worth after"), h("strong", null, r.outstandingMinor != null ? f(r.outstandingMinor) : "—")));
    } catch (err) {
      ready = false;
      add.disabled = true;
      found.replaceChildren(h("span", { class: "tt-error" }, errorText(err)));
    }
  }

  async function apply() {
    const r = await attempt(dialog, () => walletApi.importStatement(p.id, text.value, byDay.input.checked, true, todayKey()));
    if (!r) return;
    ctx.toast(`Added ${r.added} payment${r.added === 1 ? "" : "s"} from the statement`);
    ctx.changed();
    dialog.close();
  }
}

/** Add or edit a DPS or a loan: its terms, where it's paid from, and a live preview of the table's totals. */
export function planSheet(ctx: Ctx, existing: Plan | null, kind: "dps" | "loan") {
  const s = ctx.state();
  const loan = kind === "loan";
  const everyday = everydayAccounts(ctx, existing?.payFrom);
  const payFrom = h("select", { class: "wl-select", "aria-label": "Paid from" },
    ...everyday.map((a) => h("option", { value: a.id, selected: a.id === existing?.payFrom }, a.name)));
  if (!existing) payFrom.value = everyday.find((a) => a.kind === "bank")?.id ?? everyday[0]?.id ?? "";
  const name = textInput({ placeholder: loan ? "e.g. BRAC Bank loan, Car loan" : "e.g. City Bank DPS", "aria-label": "Name", value: existing?.name ?? "", "data-autofocus": "" });
  const symbol = h("span", { class: "wl-amount-symbol" });
  const amount = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "0", "aria-label": "Amount", value: existing ? plain(existing.amountMinor, existing.currency) : "" });
  const rate = textInput({ class: "tt-input wl-every", inputmode: "decimal", placeholder: "12.05", "aria-label": "Rate", value: existing ? String(existing.rateBp / 100) : "" });
  const months = textInput({ class: "tt-input wl-every", inputmode: "numeric", placeholder: "60", "aria-label": "Months", value: existing ? String(existing.months) : "" });
  const method = h("select", { class: "wl-select", "aria-label": "Interest" },
    h("option", { value: "daily", selected: (existing?.method ?? "daily") === "daily" }, "By the day, on what's still owed (as banks do)"),
    h("option", { value: "reducing", selected: existing?.method === "reducing" }, "By the month, on what's still owed"),
    h("option", { value: "flat", selected: existing?.method === "flat" }, "Flat, on the amount borrowed"));
  const typed = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "worked out", "aria-label": loan ? "Installment" : "Maturity value",
    value: existing ? (loan ? (existing.paymentTyped != null ? plain(existing.paymentTyped, existing.currency) : "") : existing.maturityTyped != null ? plain(existing.maturityTyped, existing.currency) : "") : "" });
  const typedSymbol = h("span", { class: "wl-amount-symbol" });
  // A new plan's first installment: a month from today, the usual first due date.
  const nextMonth = () => {
    const d = new Date();
    return dateKey(new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), 28)));
  };
  const start = new DateTimeField({ value: parseDate(existing?.startDate ?? nextMonth()).getTime(), placeholder: "Pick a day", label: "First installment", dateOnly: true, future: true, host: () => dialog.overlay,
    onChange: () => {
      if (!disburseTouched) disburse.set(null, false);
      schedule();
    } });
  let disburseTouched = !!existing;
  const disburse = new DateTimeField({ value: existing ? parseDate(existing.disburseDate).getTime() : null, placeholder: "A month before the first installment", label: "Lent on", dateOnly: true, future: true, clearable: true, host: () => dialog.overlay,
    onChange: () => ((disburseTouched = true), schedule()) });
  const paidBefore = textInput({ class: "tt-input wl-every", inputmode: "numeric", value: String(existing?.paidBefore ?? 0), "aria-label": "Installments already paid" });
  const auto = onOff("Pay it by itself", "Each installment moves from the account it's paid from on its date, catching up on days Zazabor Home was closed. Off: add each payment yourself, as you really paid it.", existing?.autoPost ?? !loan);
  const inTotal = onOff("Count in the total balance", loan
    ? "Off: what's owed stays out of your total balance and net worth (only its installments leave your bank). On: it's taken off them."
    : "On: what's saved in it counts in your total balance and net worth.", existing?.inTotal ?? !loan);
  const disburseTo = h("select", { class: "wl-select", "aria-label": "Arrived in" },
    h("option", { value: "" }, "Not in Wallet (already spent, or before)"),
    ...everydayAccounts(ctx, existing?.disburseTo).map((a) => h("option", { value: a.id, selected: a.id === existing?.disburseTo }, a.name)));
  const color = swatches(existing?.color ?? (loan ? "red" : "teal"), () => undefined);
  const details = detailsEditor(kind, accountOf(ctx, existing?.accountId)?.details);
  const preview = h("div", { class: "wl-plan-preview", "aria-live": "polite" });

  const methodField = field("Interest", method);
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : loan ? "Add Loan" : "Add DPS");
  const dialog = openDialog({
    title: existing ? `Edit ${existing.name}` : loan ? "New loan" : "New DPS",
    subtitle: loan ? "Its table is worked out from what you pay, like the bank's statement. Changes here rework it." : "A monthly deposit scheme: the same amount each month, growing to its maturity value.",
    icon: loan ? "bank" : "target",
    tone: "work",
    class: "wl-dialog",
    body: [
      field("Name", name),
      h("div", { class: "tt-pair" },
        field(loan ? "Amount borrowed" : "Deposit each month", h("div", { class: "wl-amount" }, symbol, amount)),
        field("Paid from", payFrom)),
      h("div", { class: "tt-pair" },
        field("Rate", h("div", { class: "wl-inline" }, rate, h("span", { class: "tt-hint" }, "% a year"))),
        field("Runs for", h("div", { class: "wl-inline" }, months, h("span", { class: "tt-hint" }, "months")))),
      loan ? methodField : null,
      loan ? h("div", { class: "tt-pair" }, field("Lent on", disburse.el, { note: h("span", { class: "tt-hint" }, "interest runs from it") }), field("The money arrived in", disburseTo, { optional: true })) : null,
      h("div", { class: "tt-pair" },
        field("First installment", start.el),
        field(loan ? "Installment" : "Maturity value", h("div", { class: "wl-amount" }, typedSymbol, typed), { optional: true, note: h("span", { class: "tt-hint" }, "from the bank") })),
      field("Installments already paid", h("div", { class: "wl-inline" }, paidBefore, h("span", { class: "tt-hint" }, "before you added it here, if you won't add their payments"))),
      auto.row,
      inTotal.row,
      details.el,
      field("Colour", color.el),
      preview,
    ],
    foot: [
      existing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null,
      h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save,
    ],
    submit: () => void submit(),
  });

  function input(): PlanInput | null {
    const startMs = start.get();
    if (startMs == null) return null;
    const lent = disburse.get();
    return {
      id: existing?.id ?? null, kind, name: name.value, color: color.get(), amount: amount.value, rate: rate.value,
      months: Number(months.value) || 0, startDate: dateKey(new Date(startMs)), method: method.value as Plan["method"],
      payment: loan ? typed.value : null, maturity: loan ? null : typed.value, paidBefore: Math.max(0, Number(paidBefore.value) || 0),
      payFrom: payFrom.value, autoPost: auto.input.checked, disburseTo: disburseTo.value || null,
      disburseDate: lent != null ? dateKey(new Date(lent)) : null, inTotal: inTotal.input.checked, details: details.get(),
    };
  }

  let timer = 0;
  let asked = 0;
  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 180);
  }
  async function refresh() {
    const code = accountOf(ctx, payFrom.value)?.currency ?? s.base;
    symbol.textContent = symbolOf(code).trim();
    typedSymbol.textContent = symbolOf(code).trim();
    typed.disabled = loan && method.value === "flat";
    const i = input();
    if (!i || !amount.value.trim() || !i.months) {
      preview.replaceChildren(h("span", { class: "tt-hint" }, "Type the amount, the rate and the months to see the table's totals."));
      return;
    }
    const mine = ++asked;
    try {
      const p = await walletApi.planPreview(i);
      if (mine !== asked) return;
      const f = (n: number) => fmt(ctx, n, code);
      preview.replaceChildren(
        h("div", null, h("span", { class: "wl-stat-label" }, loan ? "Installment" : "Deposit"), h("strong", null, f(p.paymentMinor))),
        h("div", null, h("span", { class: "wl-stat-label" }, loan ? "Interest in all" : "Interest"), h("strong", null, f(p.interestMinor))),
        h("div", null, h("span", { class: "wl-stat-label" }, loan ? "Paid back" : "At maturity"), h("strong", null, f(p.totalMinor))),
        h("div", null, h("span", { class: "wl-stat-label" }, loan ? "Last one" : "Matures"), h("strong", null, shortDate(p.endDate))));
    } catch (err) {
      if (mine === asked) preview.replaceChildren(h("span", { class: "tt-error" }, errorText(err)));
    }
  }
  for (const el of [amount, rate, months, typed, paidBefore]) el.addEventListener("input", schedule);
  for (const el of [method, payFrom]) el.addEventListener("change", schedule);
  void refresh();

  async function submit() {
    if (!name.value.trim()) return dialog.error("Give it a name.");
    if (!payFrom.value) return dialog.error("Add an everyday account (a bank account or cash) to pay it from first.");
    const i = input();
    if (!i) return dialog.error("Pick the first installment's date.");
    const saved = await attempt(dialog, () => walletApi.savePlan(i, todayKey()));
    if (!saved) return;
    const p = saved.plan;
    ctx.toast(existing ? `${p.name} saved: its table is worked out again` : `Added ${p.name}: ${fmt(ctx, p.paymentMinor, p.currency)} a month for ${p.installments} months`);
    ctx.go("plans", { accountId: p.id });
    ctx.changed();
    dialog.close();
  }

  async function del() {
    if (!existing) return;
    const yes = await confirmDialog({ title: `Delete ${existing.name}?`, text: "What it already posted stays, as ordinary transfers, and so does its account.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (yes && (await attempt(dialog, () => walletApi.deletePlan(existing.id).then(() => true)))) {
      ctx.toast(`${existing.name} deleted`);
      ctx.changed();
      dialog.close();
    }
  }
}
