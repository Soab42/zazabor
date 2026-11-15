import "../styles.css";
import "./mobile.css";
import { applyAppearance } from "../appearance";
import { parseConfig, type Config } from "../config";
import type { ShellContext } from "../shell/module";
import { createWalletModule } from "../modules/wallet";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { showToast } from "../modules/files/ops/toast";
import { phoneSync } from "./sync";

/**
 * Zazabor Wallet on Android: the desktop's Wallet module with a phone shell around it. The
 * sidebar becomes a drawer behind a menu button; settings live in the WebView's storage since
 * there is no desktop config here.
 */

const CONFIG_KEY = "zazabor-wallet-config";

function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return parseConfig(raw);
  } catch (err) {
    console.warn("Wallet settings unreadable, using defaults:", err);
  }
  return parseConfig("{}");
}

const config = loadConfig();
config.appearance.mode = "system";
applyAppearance(config.appearance);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyAppearance(config.appearance));

let saveTimer: number | undefined;
const shell: ShellContext = {
  config,
  saveConfig() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      } catch (err) {
        console.error("Saving wallet settings failed:", err);
      }
    }, 300);
  },
  open: () => {},
  openExternally: () => {},
  showModule: () => {},
  openSettings: () => {},
  lock: { enabled: false, lockNow: () => {}, authorize: async () => true, openSettings: () => {} },
};

const wallet = await createWalletModule(shell);
const app = document.getElementById("app")!;
app.append(wallet.el);
wallet.activate();

// The sidebar as a drawer: a menu button at the start of the bar, a scrim to close it, and any
// pick inside it closes it again.
const side = wallet.el.querySelector<HTMLElement>(".wl-side");
const bar = wallet.el.querySelector<HTMLElement>(".wl-bar");
if (side && bar) {
  const setOpen = (open: boolean) => wallet.el.classList.toggle("drawer-open", open);
  const scrim = h("div", { class: "phone-scrim", onclick: () => setOpen(false) });
  wallet.el.append(scrim);
  bar.prepend(h("button", { class: "icon-btn phone-menu", type: "button", "aria-label": "Menu", onclick: () => setOpen(true) }, icon("sidebar", 20)));
  bar.querySelector(".wl-new")?.before(phoneSync((text) => showToast(text, undefined, 3200)));
  bar.append(h("div", { class: "phone-break" }));
  side.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, a")) setOpen(false);
  });
  // Android's back button closes the drawer first.
  history.pushState({ wallet: true }, "");
  addEventListener("popstate", () => {
    if (wallet.el.classList.contains("drawer-open")) setOpen(false);
    history.pushState({ wallet: true }, "");
  });
}

addEventListener("keydown", (e) => {
  if (wallet.handleKey(e)) e.preventDefault();
});
