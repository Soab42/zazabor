import type { ShellContext } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { showToast } from "../files/ops/toast";
import "../time/time-module.css";
import { openDialog } from "../time/dialog";
import { errorText, walletApi, type Tx, type WalletState } from "./api";
import { addMonths, money, setCurrencies, shortDate, thisMonth } from "./format";
import "./wallet.css";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * "Attach to Wallet Transaction…" from Files: pick one of the recent transactions (search finds
 * older ones) and the pictures or PDFs become its receipts. Works in any window, without leaving
 * the section it's in.
 */
export async function attachToTransaction(paths: string[], shell: ShellContext) {
  let state: WalletState;
  try {
    state = await walletApi.state();
  } catch (err) {
    showToast(errorText(err), undefined, 5000);
    return;
  }
  setCurrencies(state.currencies, state.base);
  const hidden = shell.config.wallet.hideAmounts;
  let items: Tx[] = [];
  let chosen: string | null = null;
  const search = h("input", { class: "search-input", type: "search", placeholder: "Search payee, note, category", "aria-label": "Search transactions", spellcheck: "false", "data-autofocus": "" });
  const list = h("div", { class: "wl-pick-list", role: "listbox" });
  const attach = h("button", { class: "btn primary", type: "button", disabled: true, onclick: () => void submit() }, icon("paperclip", 14), "Attach");
  const dialog = openDialog({
    title: "Attach to a transaction",
    subtitle: paths.length === 1 ? baseName(paths[0]) : `${paths.length} files`,
    icon: "paperclip",
    tone: "work",
    class: "wl-dialog wl-attach",
    body: [h("label", { class: "search wl-search" }, icon("search", 15), search), list],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), attach],
    submit: () => void submit(),
  });

  const name = (t: Tx) => t.payee || state.categories.find((c) => c.id === t.categoryId)?.name || "Uncategorised";
  function draw() {
    attach.disabled = !chosen;
    list.replaceChildren(...(items.length ? items.map((t) => {
      const account = state.accounts.find((a) => a.id === t.accountId);
      return h("button", {
        class: `wl-pick${chosen === t.id ? " selected" : ""}`, type: "button", role: "option", "aria-selected": String(chosen === t.id),
        onclick: () => ((chosen = t.id), draw()), ondblclick: () => ((chosen = t.id), void submit()),
      },
      h("span", { class: "wl-pick-date" }, shortDate(t.date)),
      h("span", { class: "wl-pick-name" }, name(t), account ? h("span", { class: "wl-card-sub" }, ` · ${account.name}`) : null),
      h("span", { class: "wl-pick-clip" }, t.receipts ? icon("paperclip", 12) : null),
      h("span", { class: `wl-tx-amount ${t.kind === "income" ? "in" : "out"}` }, money(t.amountMinor, t.currency, { hidden, signed: true })));
    }) : [h("p", { class: "wl-chart-empty" }, "No transactions match.")]));
  }

  let ticket = 0;
  async function load() {
    const mine = ++ticket;
    const text = search.value.trim();
    try {
      const page = await walletApi.list({ search: text || null, from: text ? null : `${addMonths(thisMonth(), -2)}-01`, limit: 120 });
      if (mine !== ticket) return;
      items = page.items.filter((t) => t.kind !== "transfer");
      if (chosen && !items.some((t) => t.id === chosen)) chosen = null;
    } catch (err) {
      dialog.error(errorText(err));
    }
    draw();
  }
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void load(), 150);
  });

  async function submit() {
    if (!chosen) return;
    const t = items.find((x) => x.id === chosen);
    dialog.busy(true);
    try {
      const added = await walletApi.attach(chosen, paths);
      dialog.close();
      showToast(`Attached ${added.length === 1 ? `“${added[0].name}”` : `${added.length} receipts`} to ${t ? name(t) : "the transaction"}`, undefined, 3500);
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }
  void load();
}
