import { open as openFiles, save as saveFile } from "../../../shared/dialog";
import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { confirmDialog, field, openDialog, textInput } from "../../time/dialog";
import { errorText, walletApi, type Batch, type Filter, type ImportPreview, type Mapping, type Profile, type Rule } from "../api";
import { accountOf, categoryName, fmt, type Ctx } from "../ctx";
import { shortDate, thisMonth, todayKey } from "../format";

const STATEMENTS = [{ name: "Statements (CSV, Excel)", extensions: ["csv", "tsv", "txt", "xlsx", "xlsm"] }];
/** Rows shown in the preview (all of them are added). */
const SHOWN = 300;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);

/** Category options of both kinds, sub-categories indented; "" is Uncategorised. */
function categoryOptions(ctx: Ctx, value: string | null): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [h("option", { value: "" }, "Uncategorised")];
  for (const kind of ["expense", "income"] as const) {
    const cats = ctx.state().categories.filter((c) => c.kind === kind && (!c.archived || c.id === value));
    for (const top of cats.filter((c) => !c.parentId)) {
      options.push(h("option", { value: top.id, selected: top.id === value }, top.name));
      for (const child of cats.filter((c) => c.parentId === top.id)) options.push(h("option", { value: child.id, selected: child.id === value }, ` ${child.name}`));
    }
  }
  return options;
}

/** Picks a statement and opens the wizard for an account. */
export async function startImport(ctx: Ctx, accountId: string) {
  const path = await openFiles({ title: "Import a Statement", filters: STATEMENTS });
  if (path) importWizard(ctx, path, accountId);
}

/**
 * Bring a statement in: map its columns (CorePro guesses them), see every row with its category
 * and whether it's already in the wallet, leave rows out or change their category, then add the
 * new ones as one batch (Undo takes it back).
 */
export function importWizard(ctx: Ctx, path: string, accountId: string) {
  let preview: ImportPreview | null = null;
  let mapping: Mapping | null = null;
  let sheet: number | null = null;
  let profiles: Profile[] = [];
  const excluded = new Set<number>();
  const categories = new Map<number, string | null>();
  const account = accountOf(ctx, accountId);

  const mappingBox = h("div", { class: "wl-map" });
  const summary = h("div", { class: "wl-import-summary" });
  const table = h("div", { class: "wl-import-table" });
  const commit = h("button", { class: "btn primary", type: "button", onclick: () => void add() }, "Add");
  const saveProfile = h("button", { class: "btn ghost", type: "button", onclick: () => void keepProfile() }, icon("save", 14), "Save Mapping…");
  const dialog = openDialog({
    title: `Import into ${account?.name ?? "the account"}`,
    subtitle: baseName(path),
    icon: "download",
    tone: "work",
    class: "wl-dialog wl-import",
    body: [mappingBox, summary, table],
    foot: [saveProfile, h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), commit],
  });

  async function load() {
    dialog.busy(true);
    dialog.error("");
    try {
      preview = await walletApi.importPreview(path, sheet, accountId, mapping);
      mapping = preview.mapping;
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
    draw();
  }

  function columnSelect(label: string, value: number | null, optional: boolean, set: (v: number | null) => void): HTMLElement {
    const select = h("select", { class: "wl-select", "aria-label": label },
      optional ? h("option", { value: "" }, "—") : null,
      ...(preview?.columns ?? []).map((name, i) => h("option", { value: String(i), selected: i === value }, `${letter(i)}: ${name || "(no name)"}`)));
    if (value == null) select.value = "";
    select.addEventListener("change", () => (set(select.value === "" ? null : Number(select.value)), void load()));
    return field(label, select, { optional });
  }

  function drawMapping() {
    if (!preview || !mapping) return mappingBox.replaceChildren();
    const m = mapping;
    const twoColumns = m.amount == null;
    const header = textInput({ class: "tt-input wl-every", inputmode: "numeric", value: String(m.headerRow + 1), "aria-label": "Column names on row" });
    header.addEventListener("change", () => ((m.headerRow = Math.max(0, (Number(header.value) || 1) - 1)), void load()));
    const order = h("select", { class: "wl-select", "aria-label": "Dates" },
      ...([["dmy", "Day / month / year"], ["mdy", "Month / day / year"], ["ymd", "Year / month / day"]] as const).map(([v, l]) => h("option", { value: v, selected: m.dateOrder === v }, l)));
    order.addEventListener("change", () => ((m.dateOrder = order.value as Mapping["dateOrder"]), void load()));
    const amountsAs = h("select", { class: "wl-select", "aria-label": "Amounts" },
      h("option", { value: "one", selected: !twoColumns }, "One amount column"), h("option", { value: "two", selected: twoColumns }, "Money out and money in"));
    amountsAs.addEventListener("change", () => {
      if (amountsAs.value === "one") {
        m.amount = m.debit ?? m.credit ?? 0;
        m.debit = m.credit = null;
      } else {
        m.debit = m.amount ?? 0;
        m.credit = null;
        m.amount = null;
      }
      void load();
    });
    const sign = h("select", { class: "wl-select", "aria-label": "Spending is" },
      h("option", { value: "negative-out", selected: m.sign === "negative-out" }, "Spending has a minus"), h("option", { value: "positive-out", selected: m.sign === "positive-out" }, "Spending is positive"));
    sign.addEventListener("change", () => ((m.sign = sign.value as Mapping["sign"]), void load()));
    const comma = h("input", { type: "checkbox", "aria-label": "Decimal comma" });
    comma.checked = m.decimalComma;
    comma.addEventListener("change", () => ((m.decimalComma = comma.checked), void load()));
    const sheets = preview.sheets.length > 1
      ? field("Sheet", (() => {
        const sel = h("select", { class: "wl-select", "aria-label": "Sheet" }, ...preview.sheets.map((n, i) => h("option", { value: String(i), selected: i === (sheet ?? 0) }, n)));
        sel.addEventListener("change", () => ((sheet = Number(sel.value)), (mapping = null), void load()));
        return sel;
      })())
      : null;
    const profilePick = profiles.length
      ? field("Saved mapping", (() => {
        const sel = h("select", { class: "wl-select", "aria-label": "Saved mapping" }, h("option", { value: "" }, "—"), ...profiles.map((p) => h("option", { value: p.id }, p.name)));
        sel.addEventListener("change", () => {
          const p = profiles.find((x) => x.id === sel.value);
          if (p) (mapping = structuredClone(p.mapping)), void load();
        });
        return sel;
      })(), { optional: true })
      : null;
    mappingBox.replaceChildren(
      h("div", { class: "wl-map-grid" },
        sheets, profilePick,
        field("Column names on row", header),
        columnSelect("Date", m.date, false, (v) => (m.date = v ?? 0)),
        field("Dates are", order),
        columnSelect("Description", m.description, true, (v) => (m.description = v)),
        field("Amounts", amountsAs),
        ...(twoColumns
          ? [columnSelect("Money out", m.debit, true, (v) => (m.debit = v)), columnSelect("Money in", m.credit, true, (v) => (m.credit = v))]
          : [columnSelect("Amount", m.amount, false, (v) => (m.amount = v)), field("Spending", sign)]),
        columnSelect("Category", m.category, true, (v) => (m.category = v)),
        h("label", { class: "wl-check" }, comma, "Decimal comma (1.250,50)")));
  }

  function draw() {
    drawMapping();
    if (!preview) {
      summary.replaceChildren();
      table.replaceChildren();
      commit.disabled = true;
      return;
    }
    const p = preview;
    const adding = p.rows.filter((r) => !r.error && !r.duplicate && !excluded.has(r.line)).length;
    commit.disabled = adding === 0;
    commit.textContent = adding ? `Add ${adding} Transaction${adding === 1 ? "" : "s"}` : "Nothing to Add";
    summary.replaceChildren(...[
      h("span", { class: "wl-pill good" }, `${p.newCount} new`),
      p.duplicates ? h("span", { class: "wl-pill" }, `${p.duplicates} already in Wallet`) : null,
      p.errors ? h("span", { class: "wl-pill warn" }, `${p.errors} not transactions`) : null,
      excluded.size ? h("span", { class: "wl-pill" }, `${excluded.size} left out`) : null,
    ].filter((n): n is HTMLSpanElement => !!n));
    const rows = p.rows.slice(0, SHOWN).map((r) => {
      const usable = !r.error && !r.duplicate;
      const include = h("input", { type: "checkbox", "aria-label": `Add row ${r.line}`, disabled: !usable });
      include.checked = usable && !excluded.has(r.line);
      include.addEventListener("change", () => (include.checked ? excluded.delete(r.line) : excluded.add(r.line), draw()));
      const cat = h("select", { class: "wl-select small", "aria-label": `Category of row ${r.line}`, disabled: !usable }, ...categoryOptions(ctx, categories.has(r.line) ? categories.get(r.line)! : r.categoryId));
      cat.addEventListener("change", () => categories.set(r.line, cat.value || null));
      const status = r.error ? h("span", { class: "wl-row-status warn" }, r.error)
        : r.duplicate ? h("span", { class: "wl-row-status" }, "Already in Wallet")
          : r.rule ? h("span", { class: "wl-row-status good", title: `Rule: “${r.rule}”` }, "Rule") : h("span", { class: "wl-row-status good" }, "New");
      return h("div", { class: `wl-import-row${usable ? "" : " off"}` },
        include,
        h("span", { class: "wl-import-line" }, String(r.line)),
        h("span", { class: "wl-import-date" }, r.date ? shortDate(r.date) : "—"),
        h("span", { class: "wl-import-payee", title: r.payee }, r.payee || "—"),
        h("span", { class: `wl-import-amount ${(r.amountMinor ?? 0) > 0 ? "in" : "out"}` }, r.amountMinor != null ? fmt(ctx, r.amountMinor, account?.currency, { signed: true }) : "—"),
        cat, status);
    });
    table.replaceChildren(
      h("div", { class: "wl-import-row head" }, h("span", null), h("span", null, "Row"), h("span", null, "Date"), h("span", null, "Description"), h("span", null, "Amount"), h("span", null, "Category"), h("span", null)),
      ...rows,
      ...(p.rows.length > SHOWN ? [h("p", { class: "tt-hint" }, `And ${p.rows.length - SHOWN} more rows, added as they're read.`)] : []));
  }

  async function add() {
    if (!preview || !mapping) return;
    const edits = preview.rows
      .filter((r) => excluded.has(r.line) || categories.has(r.line))
      .map((r) => ({ line: r.line, include: !excluded.has(r.line), categoryId: categories.has(r.line) ? categories.get(r.line)! : r.categoryId }));
    dialog.busy(true);
    try {
      const batch = await walletApi.importCommit(path, sheet, accountId, mapping, edits);
      dialog.close();
      ctx.toast(`Added ${batch.added} from ${batch.file}`, { label: "Undo", run: () => void undoImport(ctx, batch) });
      ctx.changed();
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }

  async function keepProfile() {
    if (!mapping) return;
    const name = textInput({ placeholder: "e.g. City Bank CSV", value: account ? `${account.name} statement` : "", "aria-label": "Name", "data-autofocus": "" });
    let ok = false;
    const ask = openDialog({
      title: "Save this mapping",
      subtitle: "Next time, pick it for a statement from the same bank.",
      icon: "save",
      tone: "others",
      class: "wl-dialog",
      body: [field("Name", name)],
      foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => ask.close() }, "Cancel"), h("button", { class: "btn primary", type: "button", onclick: () => ((ok = true), ask.close()) }, "Save")],
      submit: () => ((ok = true), ask.close()),
      onClose: async () => {
        if (!ok || !mapping) return;
        try {
          const p = await walletApi.saveProfile(name.value, accountId, mapping);
          ctx.toast(`Saved “${p.name}”`);
          profiles = await walletApi.profiles();
          drawMapping();
        } catch (err) {
          ctx.toast(errorText(err));
        }
      },
    });
  }

  void (async () => {
    profiles = await walletApi.profiles().catch(() => []);
    // A mapping saved for this account comes first.
    const mine = profiles.find((p) => p.accountId === accountId);
    if (mine) mapping = structuredClone(mine.mapping);
    await load();
  })();
}

export async function undoImport(ctx: Ctx, batch: Batch) {
  try {
    const n = await walletApi.importUndo(batch.id);
    ctx.toast(`Removed ${n} transaction${n === 1 ? "" : "s"} from ${batch.file}`);
    ctx.changed();
  } catch (err) {
    ctx.toast(errorText(err));
  }
}

/** Export: transactions (as filtered) to CSV or Excel, or the whole wallet as JSON. */
export function exportDialog(ctx: Ctx, filter: Filter) {
  type Kind = "csv" | "xlsx" | "json";
  let kind: Kind = "csv";
  const kinds: [Kind, string, string][] = [["csv", "CSV", "Opens anywhere"], ["xlsx", "Excel", "A sheet for each month"], ["json", "Whole wallet (JSON)", "Every account, bill and rule: a full copy"]];
  const buttons = kinds.map(([id, label, note]) => h("button", { class: "wl-export-kind", type: "button", onclick: () => ((kind = id), draw()) }, h("strong", null, label), h("span", null, note)));
  const draw = () => buttons.forEach((b, i) => b.classList.toggle("active", kinds[i][0] === kind));
  const go = h("button", { class: "btn primary", type: "button", onclick: () => void run() }, "Export…");
  const filtered = !!(filter.from || filter.to || filter.accountId || filter.categoryId || filter.kind || filter.search);
  const dialog = openDialog({
    title: "Export",
    subtitle: filtered ? "The transactions the filters show." : "Every transaction.",
    icon: "saveAs",
    tone: "others",
    class: "wl-dialog",
    body: [h("div", { class: "wl-export-kinds" }, ...buttons)],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), go],
    submit: () => void run(),
  });
  draw();

  async function run() {
    const ext = kind === "xlsx" ? "xlsx" : kind;
    const name = kind === "json" ? `Wallet ${todayKey()}.json` : `Wallet ${filter.from?.slice(0, 7) ?? thisMonth()}.${ext}`;
    const path = await saveFile({ title: "Export Wallet", defaultPath: name, filters: [{ name: kinds.find((k) => k[0] === kind)![1], extensions: [ext] }] });
    if (!path) return;
    dialog.busy(true);
    try {
      const n = await walletApi.exportTo(kind, { ...filter, limit: undefined, offset: undefined }, path);
      dialog.close();
      ctx.toast(`Exported ${n} transaction${n === 1 ? "" : "s"} to ${baseName(path)}`);
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }
}

/** A rule: words in a description → a category (and a cleaner payee name). */
function ruleSheet(ctx: Ctx, existing: Rule | null, done: () => void) {
  const pattern = textInput({ placeholder: "e.g. foodpanda", value: existing?.pattern ?? "", "aria-label": "Words", "data-autofocus": "" });
  const category = h("select", { class: "wl-select", "aria-label": "Category" }, ...categoryOptions(ctx, existing?.categoryId ?? null));
  const payee = textInput({ placeholder: "Keep the description", value: existing?.payee ?? "", "aria-label": "Payee" });
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, existing ? "Save" : "Add Rule");
  const dialog = openDialog({
    title: existing ? "Edit rule" : "New rule",
    subtitle: "When an imported description contains these words, the transaction gets this category.",
    icon: "filter",
    tone: "others",
    class: "wl-dialog",
    body: [field("Description contains", pattern), field("Category", category), field("Payee name", payee, { optional: true })],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), save],
    submit: () => void submit(),
  });
  async function submit() {
    dialog.busy(true);
    try {
      await walletApi.saveRule({ id: existing?.id ?? null, pattern: pattern.value, categoryId: category.value || null, payee: payee.value });
      done();
      dialog.close();
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }
}

/**
 * Import and export: bring a statement in (CSV or Excel, from any bank or wallet), the imports
 * so far with Undo, the rules that categorise imported rows, saved mappings, and exports.
 */
export function importView(ctx: Ctx) {
  let batches: Batch[] = [];
  let rules: Rule[] = [];
  let profiles: Profile[] = [];
  const account = h("select", { class: "wl-select", "aria-label": "Into account" });
  const start = h("section", { class: "wl-card wl-import-start" });
  const history = h("section", { class: "wl-card" });
  const rulesCard = h("section", { class: "wl-card" });
  const profilesCard = h("section", { class: "wl-card" });
  const exportCard = h("section", { class: "wl-card" });
  const el = h("div", { class: "wl-view wl-import-view" }, start, h("div", { class: "wl-overview-grid" }, history, rulesCard, exportCard, profilesCard));

  async function load() {
    [batches, rules, profiles] = await Promise.all([walletApi.batches(), walletApi.rules(), walletApi.profiles()]).catch((err) => {
      ctx.toast(errorText(err));
      return [batches, rules, profiles] as const;
    });
    draw();
  }

  function head(title: string, sub: string, extra: HTMLElement | null = null) {
    return h("header", { class: "wl-card-head" }, h("div", null, h("h3", null, title), h("p", { class: "wl-card-sub" }, sub)), h("span", { class: "spacer" }), extra);
  }

  function draw() {
    const s = ctx.state();
    const keep = account.value;
    account.replaceChildren(...s.accounts.filter((a) => !a.archived).map((a) => h("option", { value: a.id }, `${a.name} (${a.currency})`)));
    if (keep && s.accounts.some((a) => a.id === keep)) account.value = keep;
    start.replaceChildren(
      h("div", { class: "wl-import-hero" },
        h("span", { class: "wl-chip wl-c-blue", style: { width: "44px", height: "44px" } }, icon("download", 22)),
        h("div", null, h("h3", null, "Import a statement"), h("p", { class: "wl-card-sub" }, "A CSV or Excel file from your bank, card or bKash. Rows already in Wallet are skipped, so importing the same statement twice adds nothing."))),
      h("div", { class: "wl-inline" }, field("Into", account), h("button", { class: "btn primary", type: "button", disabled: !account.value, onclick: () => void startImport(ctx, account.value) }, icon("folder", 15), "Choose File…")));

    history.replaceChildren(head("Recent imports", "Undo takes back everything one import added."),
      batches.length
        ? h("div", { class: "wl-batch-list" }, ...batches.map((b) => h("div", { class: `wl-batch${b.undone ? " dim" : ""}` },
          icon("file", 15),
          h("div", { class: "wl-batch-text" },
            h("span", { class: "wl-batch-name", title: b.file }, b.file),
            h("span", { class: "wl-card-sub" }, `${accountOf(ctx, b.accountId)?.name ?? "Account"} · ${new Date(b.created).toLocaleDateString()} · ${b.undone ? "undone" : `${b.added} added${b.skipped ? `, ${b.skipped} skipped` : ""}`}`)),
          !b.undone && b.remaining > 0 ? h("button", { class: "text-btn", type: "button", onclick: () => void undoAsk(b) }, "Undo") : null)))
        : h("p", { class: "wl-chart-empty" }, "Nothing imported yet."));

    rulesCard.replaceChildren(head("Rules", "Words in a description pick the category of imported rows.",
      h("button", { class: "btn small", type: "button", onclick: () => ruleSheet(ctx, null, () => void load()) }, icon("plus", 14), "Add Rule")),
    rules.length
      ? h("div", { class: "wl-rule-list" }, ...rules.map((r) => h("div", { class: "wl-rule" },
        h("span", { class: "wl-rule-pattern" }, `“${r.pattern}”`), icon("chevronRight", 12),
        h("span", { class: "wl-rule-cat" }, r.categoryId ? categoryName(ctx, r.categoryId, true) : "—", r.payee ? h("span", { class: "wl-card-sub" }, ` as ${r.payee}`) : null),
        h("span", { class: "spacer" }),
        h("button", { class: "icon-btn small", type: "button", title: "Edit", "aria-label": `Edit the rule for ${r.pattern}`, onclick: () => ruleSheet(ctx, r, () => void load()) }, icon("pencil", 13)),
        h("button", { class: "icon-btn small", type: "button", title: "Delete", "aria-label": `Delete the rule for ${r.pattern}`, onclick: () => void walletApi.deleteRule(r.id!).then(() => load(), (err) => ctx.toast(errorText(err))) }, icon("trash", 13)))))
      : h("p", { class: "wl-chart-empty" }, "No rules yet. Without one, the category comes from the words in the description and the payees you've used."));

    profilesCard.replaceChildren(head("Saved mappings", "How a bank's columns read, kept by name."),
      profiles.length
        ? h("div", { class: "wl-rule-list" }, ...profiles.map((p) => h("div", { class: "wl-rule" },
          icon("columns", 14), h("span", { class: "wl-rule-pattern" }, p.name),
          h("span", { class: "wl-card-sub" }, p.accountId ? accountOf(ctx, p.accountId)?.name ?? "" : ""), h("span", { class: "spacer" }),
          h("button", { class: "icon-btn small", type: "button", title: "Delete", "aria-label": `Delete ${p.name}`, onclick: () => void walletApi.deleteProfile(p.id).then(() => load(), (err) => ctx.toast(errorText(err))) }, icon("trash", 13)))))
        : h("p", { class: "wl-chart-empty" }, "Save a mapping from the import window to reuse it. Profiles for particular banks need a sample statement from each."));

    exportCard.replaceChildren(head("Export", "Your transactions as CSV or Excel, or the whole wallet as JSON."),
      h("div", { class: "wl-inline" },
        h("button", { class: "btn", type: "button", onclick: () => exportDialog(ctx, {}) }, icon("saveAs", 14), "Export…")));
  }

  async function undoAsk(b: Batch) {
    const yes = await confirmDialog({ title: `Undo “${b.file}”?`, text: `The ${b.remaining} transaction${b.remaining === 1 ? "" : "s"} it added are removed (with any receipts attached since).`, confirm: "Undo Import", danger: true, icon: "undo", tone: "idle" });
    if (yes) await undoImport(ctx, b);
  }

  return { id: "import" as const, title: "Import & Export", el, usesMonth: false, load };
}
