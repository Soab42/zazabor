import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { field, openDialog, textInput } from "../../time/dialog";
import { errorText, walletApi, type Account } from "../api";
import { fmt, type Ctx } from "../ctx";
import { plain, shortDate } from "../format";
import { chip, detailsEditor, swatches } from "../sheets";

type Move = "lend" | "borrow" | "back" | "repay";

const MOVE_LABEL: Record<Move, string> = { lend: "Lend", borrow: "Borrow", back: "Got Paid Back", repay: "Pay Back" };

/**
 * Money lent to and borrowed from people: one account each, whose balance is what they owe you
 * (or, below zero, what you owe them). Lending, borrowing and paying back are transfers between
 * them and your own accounts, so your cash and banks stay right and nothing counts as spending.
 */
export function peopleView(ctx: Ctx) {
  const actions = h("div", { class: "wl-view-actions" }, h("span", { class: "spacer" }),
    h("button", { class: "btn small primary", type: "button", onclick: () => personSheet(ctx, null) }, icon("plus", 14), "Add Person"));
  const summary = h("div", { class: "wl-tiles" });
  const list = h("section", { class: "wl-card wl-people" });
  const el = h("div", { class: "wl-view wl-people-view" }, actions, summary, list);

  function people(): Account[] {
    return ctx.state().accounts.filter((a) => a.kind === "person" && !a.archived)
      .sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor) || a.name.localeCompare(b.name));
  }

  /** A transfer between them and your accounts, in the transfer sheet. */
  function move(p: Account, kind: Move) {
    const mine = ctx.state().accounts.find((a) => !a.archived && a.currency === p.currency && (a.kind === "cash" || a.kind === "mobile_wallet" || a.kind === "bank"));
    const owed = kind === "back" ? Math.max(0, p.balanceMinor) : kind === "repay" ? Math.max(0, -p.balanceMinor) : 0;
    const out = kind === "lend" || kind === "repay";
    ctx.openTx(null, {
      kind: "transfer",
      accountId: out ? mine?.id ?? null : p.id,
      toAccountId: out ? p.id : mine?.id ?? null,
      amount: owed ? plain(owed, p.currency) : "",
      note: { lend: `Lent to ${p.name}`, borrow: `Borrowed from ${p.name}`, back: `${p.name} paid back`, repay: `Paid ${p.name} back` }[kind],
    });
  }

  function row(p: Account): HTMLElement {
    const owes = p.balanceMinor > 0;
    const settled = p.balanceMinor === 0;
    const more = h("button", { class: "icon-btn small", type: "button", title: "More", "aria-label": `More for ${p.name}` }, icon("more", 16));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [
        { label: "Lend…", icon: "trendDown", action: () => move(p, "lend") },
        { label: "Borrow…", icon: "trendUp", action: () => move(p, "borrow") },
        { label: "Got paid back…", icon: "check", action: () => move(p, "back") },
        { label: "Pay back…", icon: "undo", action: () => move(p, "repay") },
        "separator",
        { label: "Show the history", icon: "list", action: () => ctx.go("transactions", { accountId: p.id }) },
        { label: "Edit…", icon: "pencil", action: () => personSheet(ctx, p) },
        { label: "Archive", icon: "archive", disabled: !settled, action: () => void walletApi.archiveAccount(p.id, true).then(() => ctx.changed(), (err) => ctx.toast(errorText(err))) },
      ]);
    });
    // The likely next step: getting it back, or paying it back.
    const next: Move | null = owes ? "back" : settled ? null : "repay";
    return h("div", { class: "wl-person", role: "button", tabindex: 0, onclick: () => ctx.go("transactions", { accountId: p.id }) },
      chip("users", p.color, 32),
      h("div", { class: "wl-bill-text" },
        h("span", { class: "wl-bill-name" }, p.name),
        h("span", { class: "wl-bill-sub" }, [p.details.phone, p.lastDate ? `last ${shortDate(p.lastDate)} · ${p.txCount} entr${p.txCount === 1 ? "y" : "ies"}` : "nothing yet"].filter(Boolean).join(" · "))),
      h("div", { class: "wl-bill-due" },
        h("span", { class: `wl-person-state${owes ? " in" : settled ? "" : " out"}` }, settled ? "Settled" : owes ? "Owes you" : "You owe"),
        settled ? null : h("strong", { class: "wl-person-amount" }, fmt(ctx, Math.abs(p.balanceMinor), p.currency))),
      h("div", { class: "wl-person-actions" },
        next ? h("button", { class: "btn small", type: "button", onclick: (e: Event) => (e.stopPropagation(), move(p, next)) }, MOVE_LABEL[next]) : null,
        h("button", { class: "btn small", type: "button", onclick: (e: Event) => (e.stopPropagation(), move(p, owes || settled ? "lend" : "borrow")) }, owes || settled ? "Lend" : "Borrow")),
      more);
  }

  function draw() {
    const all = people();
    const toYou = all.filter((p) => p.balanceMinor > 0).reduce((s, p) => s + (p.balanceBaseMinor ?? 0), 0);
    const byYou = all.filter((p) => p.balanceMinor < 0).reduce((s, p) => s - (p.balanceBaseMinor ?? 0), 0);
    const tile = (label: string, value: string, sub: string) => h("section", { class: "wl-card wl-tile" }, h("span", { class: "wl-stat-label" }, label), h("strong", { class: "wl-stat-value" }, value), h("span", { class: "wl-card-sub" }, sub));
    summary.hidden = !all.length;
    actions.hidden = !all.length;
    summary.replaceChildren(
      tile("Owed to you", fmt(ctx, toYou), `${all.filter((p) => p.balanceMinor > 0).length} people`),
      tile("You owe", fmt(ctx, byYou), `${all.filter((p) => p.balanceMinor < 0).length} people`),
      tile("Net", fmt(ctx, toYou - byYou), toYou >= byYou ? "in your favour" : "you owe more than you're owed"));
    list.replaceChildren(...(all.length
      ? [h("header", { class: "wl-card-head" }, h("div", null, h("h3", null, "People"), h("p", { class: "wl-card-sub" }, "Lending and paying back move money between them and your cash or bank; none of it is spending."))), ...all.map(row)]
      : [h("div", { class: "wl-empty small" },
        h("div", { class: "wl-empty-tile glass" }, icon("users", 26)),
        h("h2", null, "Nobody owes anybody"),
        h("p", null, "Lent a friend money, or borrowed some? Add the person, and Wallet keeps what's owed until it's paid back, in parts or at once."),
        h("button", { class: "btn primary", type: "button", onclick: () => personSheet(ctx, null) }, icon("plus", 15), "Add Person"))]));
  }

  return { id: "people" as const, title: "Lent & Borrowed", el, usesMonth: false, load: async () => draw() };
}

/** Add a person (then lend or borrow), or rename one. */
export function personSheet(ctx: Ctx, existing: Account | null) {
  const s = ctx.state();
  const name = textInput({ placeholder: "e.g. Rahim, Office colleague", "aria-label": "Name", value: existing?.name ?? "", "data-autofocus": "" });
  const currency = h("select", { class: "wl-select", "aria-label": "Currency" },
    ...s.currencies.map((c) => h("option", { value: c.code, selected: (existing?.currency ?? s.base) === c.code }, `${c.code} — ${c.name}`)));
  if (existing) currency.disabled = existing.txCount > 0;
  const color = swatches(existing?.color ?? "sky", () => undefined);
  const details = detailsEditor("person", existing?.details);
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : "Add Person");
  const dialog = openDialog({
    title: existing ? `Edit ${existing.name}` : "Add a person",
    subtitle: existing ? "Their history stays." : "Then lend to them or borrow from them; paying back can come in parts.",
    icon: "users",
    tone: "work",
    class: "wl-dialog",
    body: [field("Name", name), field("Currency", currency), details.el, field("Colour", color.el)],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save],
    submit: () => void submit(),
  });

  async function submit() {
    if (!name.value.trim()) return dialog.error("Type their name.");
    dialog.busy(true);
    try {
      const saved = await walletApi.saveAccount({ id: existing?.id ?? null, name: name.value, kind: "person", currency: currency.value, opening: existing ? (existing.openingMinor < 0 ? "-" : "") + plain(existing.openingMinor, existing.currency) : "", color: color.get(), details: details.get() });
      dialog.close();
      ctx.changed();
      if (!existing) {
        // Straight on to what happened with them.
        const r = { left: window.innerWidth / 2 - 100, top: window.innerHeight / 3 };
        openMenu(r.left, r.top, [
          { label: `Lend to ${saved.name}…`, icon: "trendDown", action: () => ctx.openTx(null, { kind: "transfer", toAccountId: saved.id, note: `Lent to ${saved.name}` }) },
          { label: `Borrow from ${saved.name}…`, icon: "trendUp", action: () => ctx.openTx(null, { kind: "transfer", accountId: saved.id, note: `Borrowed from ${saved.name}` }) },
        ]);
      }
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }
}
