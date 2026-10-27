import { thumbUrl } from "../../api";
import { open as openFiles } from "../../shared/dialog";
import { openViewerWindow } from "../../shell/windows";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, walletApi, type Receipt } from "./api";
import type { Ctx } from "./ctx";
import { RECEIPT_EXTENSIONS, isReceipt } from "./drops";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Asks for pictures or PDFs of receipts (Zazabor's own picker). */
export async function pickReceipts(): Promise<string[]> {
  const paths = await openFiles({ title: "Attach Receipts", multiple: true, filters: [{ name: "Pictures and PDFs", extensions: RECEIPT_EXTENSIONS }] });
  return (paths ?? []).filter(isReceipt);
}

/** Attaches files to a transaction and says so. */
export async function attachReceipts(ctx: Ctx, transactionId: string, paths: string[]): Promise<boolean> {
  if (!paths.length) return false;
  try {
    const added = await walletApi.attach(transactionId, paths);
    ctx.toast(added.length === 1 ? `Attached “${added[0].name}”` : `Attached ${added.length} receipts`);
    ctx.changed();
    return true;
  } catch (err) {
    ctx.toast(errorText(err));
    return false;
  }
}

/**
 * The receipts of a transaction in its sheet: thumbnails (PDFs as a page icon) that open in a
 * viewer window, Attach… and a remove button each. For a transaction not saved yet the files wait
 * and are attached when it's added (`flush`).
 */
export function receiptStrip(ctx: Ctx, txId: string | null) {
  let stored: Receipt[] = [];
  let pending: string[] = [];
  const tiles = h("div", { class: "wl-receipts" });
  const attach = h("button", { class: "btn small", type: "button", onclick: () => void pickReceipts().then(add) }, icon("paperclip", 14), "Attach…");
  const el = h("div", { class: "wl-receipt-box" }, tiles, h("div", { class: "wl-receipt-foot" }, attach, h("span", { class: "tt-hint" }, "or drop pictures and PDFs onto this sheet")));

  function tile(name: string, path: string, pdf: boolean, remove: () => void): HTMLElement {
    const preview = pdf ? h("span", { class: "wl-receipt-pdf" }, icon("pdfFile", 22)) : h("img", { src: thumbUrl(path, 0, 160), alt: "", loading: "lazy", decoding: "async" });
    const t = h("div", { class: "wl-receipt", title: name },
      h("button", { class: "wl-receipt-open", type: "button", "aria-label": `Open ${name}`, onclick: () => openViewerWindow(path) }, preview),
      h("span", { class: "wl-receipt-name" }, name),
      h("button", { class: "wl-receipt-remove icon-btn small", type: "button", title: "Remove", "aria-label": `Remove ${name}`, onclick: remove }, icon("close", 11)));
    return t;
  }

  function draw() {
    tiles.replaceChildren(
      ...stored.map((r) => tile(r.name, r.path, r.mime === "application/pdf", () => void removeStored(r))),
      ...pending.map((p) => tile(baseName(p), p, p.toLowerCase().endsWith(".pdf"), () => ((pending = pending.filter((x) => x !== p)), draw()))));
    tiles.hidden = !stored.length && !pending.length;
  }

  async function load() {
    if (!txId) return draw();
    try {
      stored = await walletApi.receipts(txId);
    } catch (err) {
      ctx.toast(errorText(err));
    }
    draw();
  }

  async function removeStored(r: Receipt) {
    try {
      await walletApi.removeReceipt(r.id);
      stored = stored.filter((x) => x.id !== r.id);
      draw();
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  async function add(paths: string[]) {
    const files = paths.filter(isReceipt);
    if (!files.length) return;
    if (txId) {
      if (await attachReceipts(ctx, txId, files)) await load();
    } else {
      pending = [...new Set([...pending, ...files])];
      draw();
    }
  }

  void load();
  return {
    el,
    add,
    /** Attaches the waiting files to the transaction just added. */
    async flush(id: string) {
      if (pending.length) await attachReceipts(ctx, id, pending);
      pending = [];
    },
  };
}
