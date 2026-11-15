import type { ShellContext } from "../../shell/module";
import { isMainWindow } from "../../shell/windows";
import { phoneApi } from "./api";
import { mountCallBar } from "./callbar";
import { showPairDialog } from "./pair";
import { getState, loadContacts, onEvent, setBt, setState, startStore } from "./store";
import "./phone.css";

/**
 * Phone Link in the main window, whatever section is open: turns the link and Bluetooth calls on
 * at start when Settings says so, asks about a phone that wants to pair, and shows calls. Started
 * by the shell (and by the Phone section, for when the feature was turned on later).
 */

let started = false;

export function startPhoneService(shell: ShellContext) {
  if (started || !isMainWindow) return;
  started = true;
  const enabled = () => shell.config.features.phone;
  void startStore().then(async () => {
    const settings = shell.config.phone;
    if (settings.enabled && getState() && !getState()!.enabled) {
      await phoneApi.linkEnable(true).then(setState, (err) => console.warn("Phone Link didn't start:", err));
    }
    // Calls through this PC: Zazabor registers its Bluetooth hands-free profile.
    if (settings.calls) await phoneApi.btEnable(true).then(setBt, (err) => console.warn("Bluetooth calls didn't start:", err));
    // Names for callers.
    for (const phone of getState()?.phones ?? []) void loadContacts(phone.phoneId);
  });
  onEvent("phone-pair", (request) => {
    if (enabled()) showPairDialog(request);
  });
  // A pairing already waiting when this window loaded.
  void startStore().then(() => {
    const pairing = getState()?.pairing;
    if (pairing && enabled()) showPairDialog(pairing);
  });
  mountCallBar(() => {
    if (enabled()) shell.showModule("phone");
  });
}
