import type { SettingsRow } from "../../appearance";
import type { Config } from "../../config";
import { open as openDialog } from "../../shared/dialog";
import type { Category } from "../../shell/settings";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { agoText, errorText, phoneApi, type BtState, type PhoneState } from "./api";

/**
 * Settings → Phone: the link on or off, where files from the phone go, desktop notifications,
 * clipboard sharing, calls through this PC over Bluetooth, and the paired phones.
 */
export function phoneCategory(host: { readonly config: Config; configChanged(): void }): Category {
  const settings = () => host.config.phone;
  let state: PhoneState | null = null;

  const toggle = (label: string, hint: string, set: (on: boolean, input: HTMLInputElement) => void) => {
    const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
    input.addEventListener("change", () => set(input.checked, input));
    return { input, row: { label, el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), input) } satisfies SettingsRow };
  };
  const problem = h("p", { class: "sf-hint pl-settings-error", hidden: true });
  const fail = (err: unknown) => {
    problem.hidden = false;
    problem.textContent = errorText(err);
  };

  // ---- the link
  const link = toggle("Phone Link", "Phones with Zazabor Link on the same Wi-Fi can find this PC and pair with it.", (on, input) => {
    settings().enabled = on;
    host.configChanged();
    void phoneApi.linkEnable(on).then((next) => {
      state = next;
      drawPhones();
    }, (err) => {
      input.checked = !on;
      settings().enabled = !on;
      fail(err);
    });
  });
  const pcName = h("span", { class: "st-value" }, "—");
  const pcRow: SettingsRow = { label: "This PC's name", el: h("div", { class: "sf-row plain" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "This PC's name"), h("p", { class: "sf-hint" }, "What phones show when they look for a PC.")), pcName) };

  const folder = h("p", { class: "sf-hint pl-settings-path" });
  const choose = h("button", { class: "btn small", type: "button" }, "Choose…");
  const reset = h("button", { class: "btn small ghost", type: "button" }, "Default");
  choose.addEventListener("click", async () => {
    const dir = await openDialog({ title: "Files from the phone go to", directory: true, defaultPath: settings().downloadDir || undefined });
    if (!dir) return;
    settings().downloadDir = dir;
    host.configChanged();
    drawFolder();
  });
  reset.addEventListener("click", () => {
    settings().downloadDir = "";
    host.configChanged();
    drawFolder();
  });
  const folderRow: SettingsRow = { label: "Download folder", el: h("div", { class: "sf-row plain" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Files from the phone go to"), folder), h("div", { class: "pl-settings-buttons" }, reset, choose)) };
  const drawFolder = () => {
    folder.textContent = settings().downloadDir || "Downloads › Zazabor Link";
    reset.hidden = !settings().downloadDir;
  };

  // ---- notifications and the clipboard
  const notify = toggle("Show new texts on the desktop", "A notification with who wrote, unless that conversation is open in Zazabor.", (on) => ((settings().notify = on), host.configChanged()));
  const mirrorNotifs = toggle("Show the phone's notifications on the desktop", "Notifications from apps on the phone show on this PC too.", (on) => ((settings().mirrorNotifs = on), host.configChanged()));
  const clip = toggle("Share the clipboard", "Text you copy on this PC can be pasted on the phone, and the other way round. Turn it on in Zazabor Link too.", (on, input) => {
    settings().clip = on;
    host.configChanged();
    const phones = state?.phones ?? [];
    void Promise.all(phones.map((p) => phoneApi.clipShare(p.phoneId, on))).catch((err) => {
      input.checked = !on;
      settings().clip = !on;
      fail(err);
    });
  });

  // ---- calls
  const btStatus = h("p", { class: "sf-hint pl-settings-bt" });
  const calls = toggle("Calls through this PC", "Make and take calls with this PC's speakers and microphone over Bluetooth. Zazabor becomes the phone's hands-free: it asks the sound server (WirePlumber) to leave that role to it and restarts it, which cuts sound for a moment. Headsets keep working.", (on, input) => {
    input.disabled = true;
    void phoneApi.btEnable(on).then((bt) => {
      settings().calls = on;
      host.configChanged();
      drawBt(bt);
    }, (err) => {
      input.checked = !on;
      fail(err);
    }).finally(() => (input.disabled = false));
  });
  calls.row.el.querySelector(".st-text")?.append(btStatus);
  const btSettings = h("button", { class: "btn small", type: "button" }, icon("bluetooth", 14), "Bluetooth Settings");
  btSettings.addEventListener("click", () => void phoneApi.btSettings().catch(fail));
  const btRow: SettingsRow = { label: "Pair a phone over Bluetooth", el: h("div", { class: "sf-row plain" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Pair a phone over Bluetooth"), h("p", { class: "sf-hint" }, "The phone must be paired with this PC in the system's Bluetooth settings first.")), btSettings) };
  function drawBt(bt: BtState | null) {
    if (!bt) {
      btStatus.textContent = "Not available in this version of Zazabor.";
      calls.input.disabled = true;
      return;
    }
    calls.input.checked = bt.enabled;
    const on = bt.devices.find((d) => d.connected);
    btStatus.textContent = !bt.enabled ? "" : !bt.available ? "Bluetooth is off." : on ? `Connected: ${on.name}.` : bt.devices.some((d) => d.paired) ? "No phone is connected for calls." : "No phone is paired over Bluetooth.";
  }

  // ---- paired phones
  const phonesBox = h("div", { class: "pl-settings-phones" });
  const phonesRow: SettingsRow = { label: "Paired phones", el: phonesBox };
  function drawPhones() {
    if (state) {
      pcName.textContent = state.pcName || "—";
      link.input.checked = state.enabled;
      clip.input.checked = state.clip || settings().clip;
    }
    const phones = state?.phones ?? [];
    if (!phones.length) {
      phonesBox.replaceChildren(h("p", { class: "sf-hint pl-settings-none" }, state ? "No phone is paired yet. Open Zazabor Link on the phone and pick this PC." : "Phone Link isn't available in this version of Zazabor."));
      return;
    }
    phonesBox.replaceChildren(...phones.map((p) => {
      const forget = h("button", { class: "btn small ghost", type: "button" }, "Forget");
      forget.addEventListener("click", () => {
        forget.disabled = true;
        void phoneApi.forget(p.phoneId).then(async () => {
          state = await phoneApi.state();
          drawPhones();
        }, (err) => {
          forget.disabled = false;
          fail(err);
        });
      });
      return h("div", { class: "sf-row plain pl-settings-phone" },
        h("span", { class: `pl-card-device small${p.connected ? " on" : ""}` }, icon("phone", 16)),
        h("div", { class: "st-text" }, h("span", { class: "sf-label" }, p.name), h("p", { class: "sf-hint" }, `${p.model} · ${p.connected ? "Connected" : `Last seen ${agoText(p.lastSeen)}`}`)),
        forget);
    }));
  }

  return {
    id: "phone", title: "Phone", icon: "phone", section: "Modules",
    intro: problem,
    groups: [
      { title: "Phone Link", rows: [link.row, pcRow, folderRow] },
      { title: "Notifications", rows: [notify.row, mirrorNotifs.row, clip.row] },
      { title: "Calls", rows: [calls.row, btRow] },
      { title: "Paired phones", rows: [phonesRow] },
    ],
    refresh() {
      problem.hidden = true;
      link.input.checked = settings().enabled;
      notify.input.checked = settings().notify;
      mirrorNotifs.input.checked = settings().mirrorNotifs;
      clip.input.checked = settings().clip;
      calls.input.checked = settings().calls;
      drawFolder();
      void phoneApi.state().then((next) => (state = next), () => (state = null)).then(drawPhones);
      void phoneApi.btState().then(drawBt, () => drawBt(null));
    },
  };
}
