import { listen } from "@tauri-apps/api/event";
import type { SettingsRow } from "../../appearance";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { confirmDialog, openDialog } from "../time/dialog";
import { errorText, walletApi, type SyncInfo, type SyncPeer } from "./api";

/**
 * Wallet on other devices: the phones paired with this computer (they sync with it over the
 * Wi-Fi whenever the phone app is open) and the QR code that pairs another.
 */

/** "Synced 5 min ago", "Never synced". */
export function syncedText(at: number): string {
  if (!at) return "Never synced";
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "Synced just now";
  if (mins < 60) return `Synced ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  return `Synced ${new Date(at).toLocaleDateString()}`;
}

/** Shows the pairing QR code until a phone uses it, the dialog closes, or five minutes pass. */
export async function pairPhoneDialog(paired?: (peer: SyncPeer) => void) {
  let invite: { code: string; svg: string };
  try {
    invite = await walletApi.syncInvite();
  } catch (err) {
    const d = openDialog({ title: "Pair a phone", icon: "phone", body: [], foot: [h("button", { class: "btn primary", type: "button", onclick: () => d.close() }, "OK")] });
    d.error(errorText(err));
    return;
  }
  const qr = h("div", { class: "wl-pair-qr" },
    h("img", { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(invite.svg)}`, alt: "Pairing QR code", width: 240, height: 240 }));
  const status = h("p", { class: "wl-pair-status" }, h("span", { class: "wl-pair-dot" }), "Waiting for the phone…");
  const code = h("input", { class: "wl-pair-code", readonly: true, value: invite.code, "aria-label": "Pairing code", onfocus: (e: Event) => (e.target as HTMLInputElement).select() });
  const expiry = window.setTimeout(() => {
    status.replaceChildren("This code ran out. Close and pair again.");
    qr.classList.add("expired");
  }, 5 * 60_000);
  const stop = listen<SyncPeer>("wallet-sync-paired", (e) => {
    status.replaceChildren(icon("check", 15), `Paired with ${e.payload.name}. It's syncing now.`);
    status.classList.add("done");
    paired?.(e.payload);
    window.setTimeout(() => dialog.close(), 1800);
  });
  const dialog = openDialog({
    title: "Pair a phone",
    subtitle: "Zazabor Wallet on Android",
    icon: "phone",
    class: "wl-pair-dialog",
    body: [
      h("ol", { class: "wl-pair-steps" },
        h("li", null, "Open Zazabor Wallet on the phone."),
        h("li", null, "Tap Sync, then Pair with a computer."),
        h("li", null, "Point the camera at this code.")),
      qr,
      status,
      h("p", { class: "sf-hint" }, "The phone and this computer need to be on the same Wi-Fi. Everything between them is encrypted with a key in this code, which works once, for five minutes."),
      code,
    ],
    foot: [h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Close")],
    onClose: () => {
      clearTimeout(expiry);
      void stop.then((f) => f());
      void walletApi.syncCancelInvite();
    },
  });
}

/** The Settings row: paired phones and Pair a phone. */
export function devicesRow(onError: (err: unknown) => void): { row: SettingsRow; load(): Promise<void> } {
  const list = h("div", { class: "st-wallet-devices" });
  let info: SyncInfo | null = null;

  function draw() {
    const phones = info?.peers ?? [];
    list.replaceChildren(
      ...phones.map((p) => h("div", { class: "st-wallet-device" },
        icon(p.kind === "phone" ? "phone" : "laptop", 16),
        h("div", { class: "st-text" }, h("span", null, p.name), h("span", { class: "sf-hint" }, syncedText(p.lastSync))),
        h("button", {
          class: "text-btn", type: "button",
          onclick: async () => {
            const yes = await confirmDialog({
              title: `Forget ${p.name}?`,
              text: "It stops syncing with this computer. Nothing is deleted on either side; pair again to sync again.",
              confirm: "Forget", danger: true, icon: "phone",
            });
            if (yes) void walletApi.syncForget(p.id).then(load, onError);
          },
        }, "Forget"))),
      h("button", { class: "btn small", type: "button", onclick: () => void pairPhoneDialog(() => void load()) }, icon("phone", 13), phones.length ? "Pair Another Phone" : "Pair a Phone"),
    );
  }

  async function load() {
    try {
      info = await walletApi.syncInfo();
    } catch (err) {
      onError(err);
    }
    draw();
  }

  const row: SettingsRow = {
    label: "Phone sync devices pair android",
    el: h("div", { class: "sf-row plain wide st-notes-row" },
      h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Phones"),
        h("p", { class: "sf-hint" }, "Zazabor Wallet on an Android phone keeps the same ledger as this computer. A change on either syncs both ways over the Wi-Fi whenever the phone app is open.")),
      list),
  };
  return { row, load };
}
