import { listen } from "@tauri-apps/api/event";
import { Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { errorText, walletApi, type SyncInfo } from "../modules/wallet/api";
import { syncedText } from "../modules/wallet/devices";
import { confirmDialog, openDialog } from "../modules/time/dialog";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";

/**
 * The phone's side of sync: a button in the wallet's bar that shows how sync stands and opens
 * the Sync sheet (pair with a computer by its QR code, sync now, forget). The phone syncs by
 * itself when the app opens or comes back, a few seconds after a change, and every two minutes
 * while it's open. With no computer paired it never tries.
 */
export function phoneSync(toast: (text: string) => void): HTMLElement {
  let info: SyncInfo | null = null;
  let running: Promise<void> | null = null;
  let problem = "";
  /** Changes that sync itself made don't start another sync. */
  let quietUntil = 0;
  let soon: number | undefined;

  const button = h("button", { class: "icon-btn phone-sync", type: "button", "aria-label": "Sync", onclick: () => openSheet() }, icon("sync", 18));
  const desktops = () => info?.peers.filter((p) => p.kind === "desktop") ?? [];

  function drawButton() {
    button.classList.toggle("spinning", !!running);
    button.classList.toggle("problem", !!problem);
    button.classList.toggle("unpaired", !desktops().length);
    const last = Math.max(0, ...desktops().map((p) => p.lastSync));
    button.title = !desktops().length ? "Not syncing with a computer" : problem || syncedText(last);
  }

  async function refresh() {
    try {
      info = await walletApi.syncInfo();
    } catch {
      info = null;
    }
    drawButton();
  }

  /** Syncs with every paired computer; `loud` says how it went even when it went fine. */
  function syncNow(loud = false): Promise<void> {
    if (running) return running;
    if (!desktops().length) return Promise.resolve();
    running = (async () => {
      drawButton();
      try {
        const results = await walletApi.syncNow();
        const errors = results.flatMap((r) => ("Err" in r ? [r.Err] : []));
        problem = errors[0] ?? "";
        const got = results.reduce((n, r) => n + ("Ok" in r ? r.Ok.received : 0), 0);
        if (got) quietUntil = Date.now() + 1500;
        if (loud) toast(problem || (got ? `Synced · ${got} change${got === 1 ? "" : "s"} came in` : "Synced · up to date"));
      } catch (err) {
        problem = errorText(err);
        if (loud) toast(problem);
      } finally {
        running = null;
        await refresh();
      }
    })();
    return running;
  }

  async function pair(code: string, dialog: { error(t: string): void; busy(on: boolean): void; close(): void }) {
    dialog.error("");
    dialog.busy(true);
    try {
      const out = await walletApi.syncJoin(code.trim());
      quietUntil = Date.now() + 1500;
      dialog.close();
      toast(`Paired with ${out.peer} · ${out.received} rows came in`);
      problem = "";
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
      await refresh();
    }
  }

  function pairSheet() {
    const field = h("input", { class: "wl-pair-code-input", placeholder: "zazabor-wallet:1?…", autocomplete: "off", autocapitalize: "off", spellcheck: false, "aria-label": "Pairing code" });
    const scanButton = h("button", {
      class: "btn primary phone-scan", type: "button",
      onclick: async () => {
        try {
          if ((await requestPermissions()) !== "granted") return dialog.error("Zazabor Wallet needs the camera to read the code. You can paste the code instead.");
          const result = await scan({ formats: [Format.QRCode] });
          if (result?.content) await pair(result.content, dialog);
        } catch (err) {
          dialog.error(errorText(err));
        }
      },
    }, icon("image", 16), "Scan the QR Code");
    const dialog = openDialog({
      title: "Pair with a computer",
      icon: "laptop",
      class: "phone-sheet",
      body: [
        h("ol", { class: "wl-pair-steps" },
          h("li", null, "On the computer, open Zazabor Home → Settings → Wallet → Devices."),
          h("li", null, "Click Pair a Phone."),
          h("li", null, "Scan the code it shows. Both need to be on the same Wi-Fi.")),
        scanButton,
        h("p", { class: "sf-hint" }, "Or paste the code shown under it:"),
        field,
        h("p", { class: "sf-hint" }, "If nothing is in this phone's wallet yet, it takes the computer's ledger as it is. Otherwise the two are joined."),
      ],
      foot: [
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: () => field.value.trim() && void pair(field.value, dialog) }, "Pair"),
      ],
      submit: () => field.value.trim() && void pair(field.value, dialog),
    });
  }

  async function openSheet() {
    await refresh();
    if (!desktops().length) return pairSheet();
    const rows = desktops().map((p) => h("div", { class: "st-wallet-device" },
      icon("laptop", 18),
      h("div", { class: "st-text" }, h("span", null, p.name), h("span", { class: "sf-hint" }, syncedText(p.lastSync))),
      h("button", {
        class: "text-btn", type: "button",
        onclick: async () => {
          if (!(await confirmDialog({ title: `Forget ${p.name}?`, text: "This phone stops syncing with it. Nothing is deleted on either side.", confirm: "Forget", danger: true, icon: "laptop" }))) return;
          await walletApi.syncForget(p.id);
          dialog.close();
          await refresh();
        },
      }, "Forget")));
    const dialog = openDialog({
      title: "Sync",
      subtitle: "This phone and your computer keep one ledger",
      icon: "sync",
      class: "phone-sheet",
      body: [
        h("div", { class: "st-wallet-devices" }, ...rows),
        problem ? h("p", { class: "tt-error" }, problem) : null,
        h("p", { class: "sf-hint" }, "Syncs over the Wi-Fi whenever this app is open and the computer is on with Zazabor Home running."),
      ],
      foot: [
        h("button", { class: "btn", type: "button", onclick: () => (dialog.close(), pairSheet()) }, "Pair Another"),
        h("button", { class: "btn primary", type: "button", onclick: () => (dialog.close(), void syncNow(true)) }, icon("sync", 14), "Sync Now"),
      ],
    });
  }

  void refresh().then(() => syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow();
  });
  window.setInterval(() => document.visibilityState === "visible" && void syncNow(), 120_000);
  void listen("wallet-changed", () => {
    if (Date.now() < quietUntil || running) return;
    clearTimeout(soon);
    soon = window.setTimeout(() => void syncNow(), 4000);
  });
  return button;
}
