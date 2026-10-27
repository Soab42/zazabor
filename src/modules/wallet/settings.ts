import type { SettingsRow } from "../../appearance";
import type { Config } from "../../config";
import type { Category } from "../../shell/settings";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, walletApi, type Backup, type Earnings, type WalletState } from "./api";
import { confirmDialog } from "../time/dialog";
import { money, plain, setCurrencies, thisMonth } from "./format";

/**
 * Settings → Wallet: amounts hidden by default, how money is shown, hourly rates for Time
 * projects (for the Earnings card), and the ledger's daily backups with Restore.
 */
export function walletCategory(host: { readonly config: Config; configChanged(): void }): Category {
  let state: WalletState | null = null;
  let earnings: Earnings | null = null;
  let backups: Backup[] = [];
  const wide = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
    label: `${label} ${hint}`,
    el: h("div", { class: "sf-row plain wide st-notes-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
  });
  const note = h("p", { class: "sf-hint st-wallet-note" });

  const hide = h("input", { type: "checkbox", class: "switch", role: "switch" });
  hide.addEventListener("change", () => ((host.config.wallet.hideAmounts = hide.checked), host.configChanged()));
  const hideRow: SettingsRow = {
    label: "Hide amounts",
    el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Hide amounts"),
      h("p", { class: "sf-hint" }, "Every amount shows as ৳••• (for sharing your screen). Ctrl+H in Wallet turns it on and off.")), hide),
  };
  const auto = h("input", { type: "checkbox", class: "switch", role: "switch" });
  auto.addEventListener("change", () => ((host.config.wallet.autoImportStatements = auto.checked), host.configChanged()));
  const autoRow: SettingsRow = {
    label: "Import statements automatically",
    el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Import statements automatically"),
      h("p", { class: "sf-hint" }, "An uploaded statement goes straight in when its balances add up, no row needs a look and its account is known (picked once, then remembered). Otherwise it's shown first. Undo takes an import back.")), auto),
  };
  const base = h("span", { class: "st-value" });
  const baseRow = wide("Base currency", "Totals, budgets and reports are in it; accounts in other currencies use the rates on the Accounts view. Taka groups in lakhs and crores.", base);

  const rates = h("div", { class: "st-wallet-rates" });
  const ratesRow = wide("Hourly rates", "What an hour tracked in Time earns on each project. The Overview's Earnings card multiplies them by the month's hours.", rates);

  const backupList = h("div", { class: "st-wallet-backups" });
  const backupNow = h("button", { class: "btn small", type: "button", onclick: () => void walletApi.backupNow().then(load, fail) }, icon("download", 13), "Back Up Now");
  const backupRow = wide("Backups", "A copy of the ledger is kept each day (the last 14), and one before every restore.", h("div", { class: "st-inline st-wallet-backup-box" }, backupList, backupNow));

  function fail(err: unknown) {
    note.textContent = errorText(err);
  }

  function drawRates() {
    if (!state || !earnings) return rates.replaceChildren(h("span", { class: "sf-hint" }, "Unlock Zazabor to see them."));
    const projects = [...new Set([...earnings.projects, ...earnings.rates.map((r) => r.project)])].sort((a, b) => a.localeCompare(b));
    if (!projects.length) return rates.replaceChildren(h("span", { class: "sf-hint" }, "Projects appear here once Time has tracked work on a task with a project."));
    rates.replaceChildren(...projects.map((project) => {
      const rate = earnings!.rates.find((r) => r.project === project);
      const input = h("input", { class: "st-wallet-rate", inputmode: "decimal", placeholder: "No rate", value: rate ? plain(rate.rateMinor, rate.currency) : "", "aria-label": `Rate per hour for ${project}` });
      const currency = h("select", { "aria-label": `Currency for ${project}` }, ...state!.currencies.map((c) => h("option", { value: c.code, selected: (rate?.currency ?? state!.base) === c.code }, c.code)));
      const commit = () => void walletApi.setProjectRate(project, input.value, currency.value).then(load, fail);
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") input.blur();
      });
      currency.addEventListener("change", () => input.value && commit());
      return h("div", { class: "st-wallet-rate-row" }, h("span", { class: "st-wallet-project" }, project), input, currency, h("span", { class: "sf-hint" }, "an hour"));
    }));
  }

  function drawBackups() {
    backupList.replaceChildren(...backups.slice(0, 4).map((b) => h("div", { class: "st-wallet-backup" },
      h("span", null, b.name.replace(/\.db$/, "").replace(/^before-restore-(\d+)$/, (_, ms) => `Before a restore, ${new Date(Number(ms)).toLocaleString()}`)),
      h("button", {
        class: "text-btn", type: "button",
        onclick: async () => {
          const yes = await confirmDialog({
            title: "Restore this backup?",
            text: "The ledger goes back to how it was then. Today's ledger is saved first as a backup of its own, so this can be undone.",
            confirm: "Restore", icon: "undo", tone: "idle",
          });
          if (yes) void walletApi.restore(b.name).then(() => ((note.textContent = `Restored ${b.name}`), load()), fail);
        },
      }, "Restore"))));
  }

  async function load() {
    note.textContent = "";
    try {
      [state, earnings, backups] = await Promise.all([walletApi.state(), walletApi.earnings(thisMonth()), walletApi.backups()]);
      setCurrencies(state.currencies, state.base);
      const c = state.currencies.find((x) => x.code === state!.base);
      base.textContent = c ? `${c.name} (${c.code}) · ${money(12_500_000, c.code)}` : state.base;
    } catch (err) {
      fail(err);
    }
    drawRates();
    drawBackups();
  }

  return {
    id: "wallet", title: "Wallet", icon: "wallet", section: "Modules",
    groups: [
      { title: "Display", rows: [hideRow, baseRow] },
      { title: "Statements", rows: [autoRow] },
      { title: "Earnings", rows: [ratesRow] },
      { title: "Data", rows: [backupRow, { label: "", el: note }] },
    ],
    refresh: () => {
      hide.checked = host.config.wallet.hideAmounts;
      auto.checked = host.config.wallet.autoImportStatements;
      void load();
    },
  };
}
