import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { confirmDialog, field, openDialog, textInput } from "../../time/dialog";
import { DateTimeField } from "../../time/pickers";
import { errorText, walletApi, type Fdr, type FdrDetail } from "../api";
import { accountOf, fmt, type Ctx } from "../ctx";
import { dateKey, parseDate, plain, shortDate, symbolOf, todayKey } from "../format";
import { chip, detailsEditor, detailsLine, swatches } from "../sheets";

const percent = (bp: number) => `${(bp / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

export const PAYOUT_LABEL: Record<Fdr["payout"], string> = {
  monthly: "each month", quarterly: "each quarter", halfyearly: "every six months", yearly: "each year", maturity: "at maturity",
};

/** An FDR's card: what's in it, its rate and term, the next interest and when it matures. */
export function fdrCard(ctx: Ctx, d: FdrDetail, selected: boolean, pick: () => void, menu: (x: number, y: number) => void): HTMLElement {
  const f = d.fdr;
  const more = h("button", { class: "icon-btn small wl-card-more", type: "button", title: "More", "aria-label": `More for ${f.name}` }, icon("more", 16));
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    menu(r.left, r.bottom + 4);
  });
  const done = f.payments ? f.posted / f.payments : 0;
  const c = h("div", { class: `wl-account wl-plan wl-c-${f.color}${selected ? " selected" : ""}`, role: "button", tabindex: 0, "aria-pressed": String(selected), onclick: pick },
    h("div", { class: "wl-account-top" },
      chip("lock", f.color, 34),
      h("div", { class: "wl-account-name" }, h("strong", null, f.name), h("span", null, `FDR · ${percent(f.rateBp)} · ${f.months} months`))),
      (() => {
        const a = accountOf(ctx, f.accountId);
        const line = a ? detailsLine(a) : "";
        return line ? h("div", { class: "wl-account-details" }, line) : null;
      })(),
    h("div", { class: "wl-account-balance" }, fmt(ctx, f.balanceMinor, f.currency)),
    h("div", { class: "wl-account-base" }, f.matured ? `matured ${shortDate(f.maturityDate)}` : `${fmt(ctx, f.maturityValueMinor, f.currency)} at maturity, ${shortDate(f.maturityDate)}`),
    h("span", { class: "wl-meter", "aria-hidden": "true" }, h("span", { class: "wl-meter-fill", style: { width: `${Math.round(done * 100)}%` } })),
    h("div", { class: "wl-account-meta" },
      f.nextDate && f.nextNetMinor != null ? `Interest ${fmt(ctx, f.nextNetMinor, f.currency)} on ${shortDate(f.nextDate)}` : "All interest received",
      f.overdue ? h("span", { class: "wl-late" }, ` · ${f.overdue} due`) : null));
  c.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === c) {
      e.preventDefault();
      pick();
    }
  });
  c.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu(e.clientX, e.clientY);
  });
  c.append(more);
  return c;
}

/** An FDR's interest payments: each with its tax and what arrives, received or still to come. */
export function fdrTable(ctx: Ctx, d: FdrDetail): HTMLElement[] {
  const f = d.fdr;
  const to = f.interestTo ? accountOf(ctx, f.interestTo)?.name ?? "a missing account" : "the FDR itself";
  const tile = (label: string, value: string, sub: string) => h("div", { class: "wl-tile" }, h("span", { class: "wl-stat-label" }, label), h("strong", { class: "wl-stat-value" }, value), h("span", { class: "wl-card-sub" }, sub));
  const rows = d.rows.map((r) => h("tr", { class: `wl-plan-row ${r.kind === "posted" ? "payment" : r.kind}${r.kind === "upcoming" ? " projected" : ""}` },
    h("td", { class: "num" }, String(r.no)),
    h("td", null, shortDate(r.date), r.postedOn && r.postedOn !== r.date ? h("span", { class: "wl-plan-from" }, ` · received ${shortDate(r.postedOn)}`) : null),
    h("td", { class: "num" }, fmt(ctx, r.interestMinor, f.currency)),
    h("td", { class: "num" }, r.taxMinor ? fmt(ctx, -r.taxMinor, f.currency) : "0"),
    h("td", { class: "num" }, fmt(ctx, r.netMinor, f.currency)),
    h("td", { class: "num" }, fmt(ctx, r.valueMinor, f.currency)),
    h("td", { class: "wl-plan-state" }, r.kind === "posted"
      ? h("span", { class: "wl-card-sub" }, "Received")
      : h("button", { class: `btn small${r.kind === "due" ? " primary" : ""}`, type: "button", onclick: () => void receive(r.no) }, icon("check", 13), "Received"))));
  async function receive(no: number) {
    try {
      await walletApi.receiveFdr(f.id, no, null, todayKey());
      ctx.toast(`Interest ${no} of ${f.name} received`);
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }
  return [
    h("header", { class: "wl-card-head" },
      h("div", null,
        h("h3", null, `${f.name}: interest`),
        h("p", { class: "wl-card-sub" }, [
          `${fmt(ctx, f.principalMinor, f.currency)} at ${percent(f.rateBp)} for ${f.months} months`,
          `opened ${shortDate(f.startDate)}${f.fundedFrom ? ` from ${accountOf(ctx, f.fundedFrom)?.name ?? "?"}` : ""}`,
          `interest ${PAYOUT_LABEL[f.payout]} into ${to}${f.taxBp ? `, less ${percent(f.taxBp)} source tax` : ""}`,
          f.autoPost ? "posted by itself on the day" : "marked as received by hand",
        ].join(" · "))),
      h("span", { class: "spacer" }),
      h("button", { class: "btn small", type: "button", onclick: () => fdrSheet(ctx, f) }, icon("pencil", 13), "Edit")),
    h("div", { class: "wl-tiles wl-tiles-4 wl-plan-tiles" },
      tile("Deposit", fmt(ctx, f.principalMinor, f.currency), `matures ${shortDate(f.maturityDate)}`),
      tile("Interest", fmt(ctx, f.netMinor, f.currency), `after ${fmt(ctx, f.taxMinor, f.currency)} tax, over the term`),
      tile("Received", fmt(ctx, f.receivedMinor, f.currency), `${f.posted} of ${f.payments} payments`),
      tile("At maturity", fmt(ctx, f.maturityValueMinor, f.currency), f.interestTo ? "the deposit back" : "the deposit and its interest")),
    h("div", { class: "wl-table-scroll" },
      h("table", { class: "wl-table" },
        h("thead", null, h("tr", null, ...["#", "Date", "Interest", "Tax", "Received", "FDR value", ""].map((t, i) => h("th", { class: i >= 2 && i <= 5 ? "num" : "" }, t)))),
        h("tbody", null, ...rows))),
  ];
}

/** Add or edit an FDR: the deposit, its rate and term, how its interest is paid and where it goes. */
export function fdrSheet(ctx: Ctx, existing: Fdr | null) {
  const s = ctx.state();
  const everyday = s.accounts.filter((a) => (!a.archived || a.id === existing?.fundedFrom || a.id === existing?.interestTo) && !["dps", "loan", "fdr", "person"].includes(a.kind));
  const name = textInput({ placeholder: "e.g. City Bank FDR", "aria-label": "Name", value: existing?.name ?? "", "data-autofocus": "" });
  const currency = existing?.currency ?? s.base;
  const amount = textInput({ class: "tt-input wl-amount-input", inputmode: "decimal", placeholder: "1,00,000", "aria-label": "Amount", value: existing ? plain(existing.principalMinor, existing.currency) : "" });
  const from = h("select", { class: "wl-select", "aria-label": "Deposited from" },
    h("option", { value: "" }, "Not in Wallet (opened before)"),
    ...everyday.map((a) => h("option", { value: a.id, selected: a.id === existing?.fundedFrom }, a.name)));
  if (!existing) from.value = everyday.find((a) => a.kind === "bank")?.id ?? "";
  const rate = textInput({ class: "tt-input wl-every", inputmode: "decimal", placeholder: "9.5", "aria-label": "Rate", value: existing ? String(existing.rateBp / 100) : "" });
  const months = textInput({ class: "tt-input wl-every", inputmode: "numeric", placeholder: "12", "aria-label": "Months", value: existing ? String(existing.months) : "12" });
  const start = new DateTimeField({ value: parseDate(existing?.startDate ?? todayKey()).getTime(), placeholder: "Pick a day", label: "Opened on", dateOnly: true, future: true, host: () => dialog.overlay });
  const payout = h("select", { class: "wl-select", "aria-label": "Interest paid" },
    ...(Object.entries(PAYOUT_LABEL) as [Fdr["payout"], string][]).map(([v, l]) => h("option", { value: v, selected: (existing?.payout ?? "quarterly") === v }, l.charAt(0).toUpperCase() + l.slice(1))));
  const to = h("select", { class: "wl-select", "aria-label": "Interest goes to" },
    h("option", { value: "" }, "Stays in the FDR (earns interest too)"),
    ...everyday.map((a) => h("option", { value: a.id, selected: a.id === existing?.interestTo }, a.name)));
  if (!existing) to.value = from.value;
  const tax = textInput({ class: "tt-input wl-every", inputmode: "decimal", placeholder: "10", "aria-label": "Source tax", value: existing ? String(existing.taxBp / 100) : "10" });
  const auto = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Post the interest by itself" });
  auto.checked = existing?.autoPost ?? true;
  const inTotal = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Count in the total balance" });
  inTotal.checked = existing?.inTotal ?? true;
  const color = swatches(existing?.color ?? "teal", () => undefined);
  const details = detailsEditor("fdr", accountOf(ctx, existing?.accountId)?.details);
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : "Add FDR");
  const dialog = openDialog({
    title: existing ? `Edit ${existing.name}` : "New FDR",
    subtitle: "A fixed deposit: one amount for a term, paying interest on schedule.",
    icon: "lock",
    tone: "work",
    class: "wl-dialog",
    body: [
      field("Name", name),
      h("div", { class: "tt-pair" }, field("Amount", h("div", { class: "wl-amount" }, h("span", { class: "wl-amount-symbol" }, symbolOf(currency).trim()), amount)), field("Deposited from", from)),
      h("div", { class: "tt-pair" },
        field("Rate", h("div", { class: "wl-inline" }, rate, h("span", { class: "tt-hint" }, "% a year"))),
        field("Term", h("div", { class: "wl-inline" }, months, h("span", { class: "tt-hint" }, "months")))),
      h("div", { class: "tt-pair" }, field("Opened on", start.el), field("Interest paid", payout)),
      h("div", { class: "tt-pair" }, field("Interest goes to", to), field("Source tax", h("div", { class: "wl-inline" }, tax, h("span", { class: "tt-hint" }, "% of the interest")))),
      h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, "Post the interest by itself"),
        h("p", { class: "tt-hint" }, "On its day: the interest as income and the tax as spending, catching up on days Zazabor Home was closed. Off: press Received.")), auto),
      h("label", { class: "wl-toggle-row" }, h("div", null, h("strong", null, "Count in the total balance")), inTotal),
      details.el,
      field("Colour", color.el),
    ],
    foot: [
      existing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete") : null,
      h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save,
    ],
    submit: () => void submit(),
  });

  async function submit() {
    if (!name.value.trim()) return dialog.error("Give it a name.");
    const opened = start.get();
    if (opened == null) return dialog.error("Pick the day it was opened.");
    dialog.busy(true);
    dialog.error("");
    try {
      const d = await walletApi.saveFdr({
        id: existing?.id ?? null, name: name.value, color: color.get(), currency, amount: amount.value, rate: rate.value, months: Number(months.value) || 0,
        startDate: dateKey(new Date(opened)), payout: payout.value as Fdr["payout"], tax: tax.value, interestTo: to.value || null, fundedFrom: from.value || null,
        autoPost: auto.checked, inTotal: inTotal.checked, details: details.get(),
      }, todayKey());
      ctx.toast(existing ? `${d.fdr.name} saved` : `Added ${d.fdr.name}: ${fmt(ctx, d.fdr.netMinor, d.fdr.currency)} interest after tax over its term`);
      ctx.go("plans", { accountId: d.fdr.id });
      ctx.changed();
      dialog.close();
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }

  async function del() {
    if (!existing) return;
    const yes = await confirmDialog({ title: `Delete ${existing.name}?`, text: "Its schedule goes. What it already posted stays, as ordinary transactions, and so does its account.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (!yes) return;
    try {
      await walletApi.deleteFdr(existing.id);
      ctx.toast(`${existing.name} deleted`);
      ctx.changed();
      dialog.close();
    } catch (err) {
      dialog.error(errorText(err));
    }
  }
}
