import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, walletApi, type Guess } from "./api";
import { accountOf, categoryName, categoryOf, fmt, type Ctx } from "./ctx";
import { dayLabel, todayKey } from "./format";
import { categoryGlyph, chip } from "./sheets";

/**
 * The quick-add field: "250 lunch bkash" or "+45000 salary city bank 25 oct". While typing, the
 * guess shows as chips (amount, category, account, day, payee); Enter adds it (with Undo), Tab
 * opens the full form with the guess filled in, Esc clears.
 */
export function quickAdd(ctx: Ctx) {
  let guess: Guess | null = null;
  let ticket = 0;
  let timer = 0;
  const input = h("input", { class: "search-input", type: "text", placeholder: "Quick add: 250 lunch bkash", "aria-label": "Quick add a transaction", spellcheck: "false", autocomplete: "off" });
  const chips = h("div", { class: "wl-quick-chips", "aria-live": "polite" });
  const panel = h("div", { class: "wl-quick-panel glass-strong", hidden: true }, chips,
    h("div", { class: "wl-quick-hint" }, h("kbd", null, "Enter"), " to add · ", h("kbd", null, "Tab"), " for the full form · ", h("kbd", null, "Esc"), " to clear"));
  const el = h("div", { class: "wl-quick" }, h("label", { class: "search wl-quick-field" }, icon("plus", 15), input), panel);

  async function parse() {
    const text = input.value.trim();
    if (!text) {
      guess = null;
      panel.hidden = true;
      return;
    }
    const mine = ++ticket;
    try {
      const g = await walletApi.parse(text, todayKey());
      if (mine !== ticket) return;
      guess = g;
      draw();
    } catch (err) {
      chips.replaceChildren(h("span", { class: "wl-qchip missing" }, errorText(err)));
      panel.hidden = false;
    }
  }

  function draw() {
    if (!guess) return;
    const g = guess;
    const account = accountOf(ctx, g.accountId);
    const cat = categoryOf(ctx, g.categoryId);
    const signed = g.amountMinor == null ? null : g.kind === "income" ? g.amountMinor : -g.amountMinor;
    chips.replaceChildren(...[
      signed == null
        ? h("span", { class: "wl-qchip missing" }, "Type an amount")
        : h("span", { class: `wl-qchip amount ${g.kind === "income" ? "in" : "out"}` }, fmt(ctx, signed, account?.currency, { signed: true })),
      h("span", { class: `wl-qchip${cat ? "" : " missing"}` }, cat ? chip(categoryGlyph(cat.icon), cat.color, 18) : null, cat ? categoryName(ctx, cat.id) : "No category"),
      h("span", { class: `wl-qchip${account ? "" : " missing"}` }, account ? account.name : "No account"),
      h("span", { class: "wl-qchip" }, icon("calendar", 12), dayLabel(g.date)),
      g.payee ? h("span", { class: "wl-qchip" }, `“${g.payee}”`) : null,
    ].filter((n): n is HTMLElement => !!n));
    panel.hidden = document.activeElement !== input;
  }

  async function add() {
    await parse();
    const g = guess;
    if (!g || g.amountMinor == null) return;
    if (!g.accountId) return ctx.toast("Add an account first.");
    try {
      const tx = await walletApi.saveTx({ kind: g.kind, accountId: g.accountId, amount: g.amount, date: g.date, categoryId: g.categoryId, payee: g.payee, note: "" });
      input.value = "";
      guess = null;
      panel.hidden = true;
      ctx.toast(`Added ${fmt(ctx, tx.amountMinor, tx.currency, { signed: true })} · ${categoryName(ctx, tx.categoryId)}`, {
        label: "Undo",
        run: () => void walletApi.deleteTxs([tx.id]).then(() => ctx.changed(), (err) => ctx.toast(errorText(err))),
      });
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  function openFull() {
    const g = guess;
    ctx.openTx(null, g ? { kind: g.kind, accountId: g.accountId, amount: g.amount, categoryId: g.categoryId, date: g.date, payee: g.payee } : {});
    input.value = "";
    guess = null;
    panel.hidden = true;
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void parse(), 90);
  });
  input.addEventListener("focus", () => (panel.hidden = !guess || !input.value.trim()));
  input.addEventListener("blur", () => setTimeout(() => (panel.hidden = true), 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      void add();
    } else if (e.key === "Tab" && input.value.trim() && !e.shiftKey) {
      e.preventDefault();
      clearTimeout(timer);
      void parse().then(openFull);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      input.value = "";
      guess = null;
      panel.hidden = true;
      input.blur();
    }
  });

  return {
    el,
    focus() {
      input.focus();
      input.select();
    },
    /** Amounts or names changed (Hide amounts, a renamed account). */
    redraw: draw,
  };
}
