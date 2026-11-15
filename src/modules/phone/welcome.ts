import type { ShellContext } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { showToast } from "../files/ops/toast";
import { errorText, formatCode, phoneApi, type PhoneState } from "./api";
import { showPairDialog } from "./pair";
import { refreshState, setState } from "./store";

/** Where Zazabor Link's APK is published (with every Zazabor release). */
export const LINK_APP_URL = "https://github.com/Soab42/zazabor-home/releases/latest";

/**
 * The Phone section before a phone is paired: install Zazabor Link, turn Phone Link on, then pick
 * this PC on the phone and compare the six digits.
 */
export function renderWelcome(el: HTMLElement, shell: ShellContext, state: PhoneState | null, error: string | null) {
  const on = !!state?.enabled;
  const pairing = state?.pairing ?? null;

  const step = (n: number, done: boolean, title: string, text: string | Node, ...extra: (Node | null)[]) =>
    h("li", { class: `pl-step${done ? " done" : ""}` },
      h("span", { class: "pl-step-num" }, done ? icon("check", 14) : String(n)),
      h("div", { class: "pl-step-body" }, h("strong", null, title), h("p", null, text), ...extra));

  const getApp = h("button", { class: "btn small", type: "button" }, icon("external", 14), "Get Zazabor Link");
  getApp.addEventListener("click", () => shell.openExternally(LINK_APP_URL));
  const copy = h("button", { class: "btn small ghost", type: "button" }, icon("copy", 14), "Copy Link");
  copy.addEventListener("click", () => void navigator.clipboard.writeText(LINK_APP_URL).then(() => showToast("Link copied", undefined, 2000), () => undefined));

  const turnOn = h("button", { class: "btn primary small", type: "button" }, icon("phone", 14), "Turn On Phone Link");
  turnOn.addEventListener("click", async () => {
    turnOn.disabled = true;
    try {
      setState(await phoneApi.linkEnable(true));
      shell.config.phone.enabled = true;
      shell.saveConfig();
    } catch (err) {
      showToast(`Couldn't turn on Phone Link: ${errorText(err)}`);
      turnOn.disabled = false;
    }
  });

  let waiting: Node;
  if (pairing) {
    const show = h("button", { class: "btn primary small", type: "button" }, "Compare the Code");
    show.addEventListener("click", () => showPairDialog(pairing));
    waiting = h("div", { class: "pl-step-row" }, h("span", { class: "pl-code-chip" }, formatCode(pairing.code)), h("span", { class: "muted" }, `${pairing.name} is asking to pair.`), show);
  } else if (on) {
    const address = state?.addresses?.[0];
    // The phone's "Enter an address" takes host[:port]; the port is only needed when it isn't the usual one.
    const typed = address ? `${address}${state?.port && state.port !== 47213 ? `:${state.port}` : ""}` : null;
    waiting = h("div", { class: "pl-step-row pl-waiting" }, h("span", { class: "spinner" }),
      h("span", null, `Waiting for your phone. This PC shows up as “${state?.pcName || "Zazabor"}”`,
        ...(typed ? [". Not listed? Enter ", h("strong", null, typed), " on the phone."] : ["."])));
  } else {
    waiting = h("span", null);
  }

  const failed = error
    ? h("div", { class: "pl-welcome-error" }, icon("stAlert", 15),
      h("span", null, "Phone Link isn't available in this version of Zazabor Home yet."),
      h("button", { class: "btn small ghost", type: "button", onclick: () => void refreshState() }, "Try Again"))
    : null;

  el.replaceChildren(
    h("div", { class: "pl-welcome-inner" },
      h("div", { class: "pl-welcome-art" },
        h("div", { class: "pl-welcome-phone glass" }, icon("phone", 40)),
        h("span", { class: "pl-welcome-wave" }),
        h("div", { class: "pl-welcome-pc glass" }, icon("laptop", 40))),
      h("h1", null, "Your phone, on this PC"),
      h("p", { class: "pl-welcome-lead" }, "Read and send texts, make and take calls, see your photos and notifications, move files both ways, and show your phone's screen, all from here."),
      failed,
      h("ol", { class: "pl-steps card" },
        step(1, false, "Install Zazabor Link on your Android phone", "It comes with every Zazabor Home release. Open this page on the phone and install the APK.",
          h("div", { class: "pl-step-row" }, getApp, copy)),
        step(2, on, "Turn on Phone Link", on ? "On. Phones on the same Wi-Fi can find this PC." : "This PC then shows up for Zazabor Link on the same Wi-Fi.",
          on || error ? null : h("div", { class: "pl-step-row" }, turnOn)),
        step(3, false, "Pick this PC on the phone", "In Zazabor Link, tap Phone Link, pick this PC, and check that both screens show the same six digits.", waiting)),
      h("p", { class: "pl-welcome-note" }, "Everything between the phone and this PC is encrypted. Calls through this PC use Bluetooth and can be set up after pairing.")));
}
