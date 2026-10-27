import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { VideoContext } from "../../extensions";
import { keycaps } from "../hotkeys";
import { mediaSettings, notifyMediaSettings } from "../profiles/settings";

const BASICS: [string, string[][]][] = [
  ["Play or pause", [["Space"]]],
  ["Jump back or forward", [["←"], ["→"]]],
  ["Volume up or down", [["↑"], ["↓"]]],
  ["Fullscreen", [["F"]]],
  ["Mute", [["M"]]],
  ["Add a bookmark", [["Ctrl", "B"]]],
];

const STYLES = [
  { id: "app", title: "Follow Zazabor", text: "The player uses the accent colour and theme you chose for the whole app." },
  { id: "orange", title: "Orange accent", text: "A warm orange for buttons and the seek bar, inspired by the VLC redesign." },
] as const;

/** Whether anything modal from the main app (the first-run wizard, the lock screen) is up. */
const appBusy = () => document.querySelector(".ob-overlay") !== null || document.body.classList.contains("app-locked");

/**
 * The first time the Video module is on screen: a short glass intro with the player's look
 * and the basic keys. Stored as `introSeen`; Settings can show it again.
 */
export function createIntro(ctx: VideoContext, root: HTMLElement | null): { show(): void; watch(): void; dispose(): void } {
  let overlay: HTMLElement | null = null;
  let timer = 0;

  const show = () => {
    if (overlay) return;
    let step = 0;
    const titles = ["Welcome", "Style", "Shortcuts"];
    const body = h("div", { class: "ob-body mt-intro-body" });
    const dots = h("div", { class: "ob-dots" }, ...titles.map(() => h("span", { class: "ob-dot" })));
    const back = h("button", { class: "btn ghost", type: "button" }, icon("chevronLeft", 15), "Back");
    const next = h("button", { class: "btn primary", type: "button" });
    const sheet = h("div", { class: "ob-sheet mt-intro" }, body, h("footer", { class: "ob-foot" }, back, dots, next));
    const el = h("div", { class: "ob-overlay mt-intro-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Welcome to Video", tabIndex: -1 }, sheet);
    overlay = el;

    const finish = () => {
      const settings = mediaSettings(ctx.shell);
      settings.introSeen = true;
      ctx.shell.saveConfig();
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 260);
      overlay = null;
    };

    const welcome = () =>
      h("div", { class: "ob-step ob-center" },
        h("div", { class: "ob-mark" }, icon("film", 40)),
        h("h1", { class: "ob-hero" }, "Video, made simple"),
        h("p", { class: "ob-lead" }, "A calm player for your files, streams and cameras. Two quick things to set up, then you're watching."));

    const style = () => {
      const options = STYLES.map((s) => {
        const b = h("button", { class: `ob-feature${mediaSettings(ctx.shell).playerAccent === s.id ? " active" : ""}`, type: "button", role: "radio" },
          h("span", { class: `ob-feature-icon mt-swatch ${s.id}` }, icon("play", 20)),
          h("span", { class: "ob-feature-text" }, h("strong", null, s.title), h("span", null, s.text)),
          h("span", { class: "ob-feature-check" }, icon("check", 13)));
        b.addEventListener("click", () => {
          mediaSettings(ctx.shell).playerAccent = s.id;
          ctx.shell.saveConfig();
          notifyMediaSettings(["playerAccent"]);
          render();
        });
        return b;
      });
      return h("div", { class: "ob-step" },
        h("div", { class: "ob-head" }, h("h1", null, "Choose the player's look"), h("p", null, "You can change this later in Settings, under Video.")),
        h("div", { class: "ob-features" }, ...options));
    };

    const shortcuts = () =>
      h("div", { class: "ob-step" },
        h("div", { class: "ob-head" }, h("h1", null, "Learn the basics"), h("p", null, "These keys work while a video is playing. Press ? for the full list.")),
        h("div", { class: "mt-card mt-intro-keys" }, ...BASICS.map(([label, combos]) =>
          h("div", { class: "mt-row" }, h("span", { class: "mt-row-label" }, label), keycaps(combos)))));

    const steps = [welcome, style, shortcuts];
    const render = () => {
      const last = step === steps.length - 1;
      body.replaceChildren(steps[step]());
      back.style.visibility = step === 0 ? "hidden" : "visible";
      next.replaceChildren(...(last ? [icon("check", 16), "Start watching"] : [step === 0 ? "Get started" : "Next", icon("chevronRight", 15)]));
      [...dots.children].forEach((dot, i) => {
        dot.classList.toggle("active", i === step);
        dot.classList.toggle("past", i < step);
      });
      next.focus();
    };
    back.addEventListener("click", () => {
      step = Math.max(0, step - 1);
      render();
    });
    next.addEventListener("click", () => {
      if (step === steps.length - 1) finish();
      else {
        step++;
        render();
      }
    });
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.key === "ArrowRight" && step < steps.length - 1) next.click();
      else if (e.key === "ArrowLeft" && step > 0) back.click();
    });
    el.addEventListener("keyup", (e) => e.stopPropagation());
    document.body.append(el);
    render();
  };

  // Wait until the module is actually on screen and nothing else is asking for attention.
  const stopWatching = () => {
    clearInterval(timer);
    timer = 0;
  };
  const check = () => {
    if (mediaSettings(ctx.shell).introSeen) return stopWatching();
    if (!root || root.offsetWidth === 0 || appBusy()) return;
    stopWatching();
    setTimeout(() => {
      if (mediaSettings(ctx.shell).introSeen) return;
      if (root.offsetWidth > 0 && !appBusy()) show();
      else watch();
    }, 500);
  };
  /** Starts waiting for a good moment to show the intro (again). */
  const watch = () => {
    if (!timer && !overlay && !mediaSettings(ctx.shell).introSeen) timer = window.setInterval(check, 700);
  };
  watch();

  return {
    show,
    watch,
    dispose() {
      stopWatching();
      overlay?.remove();
      overlay = null;
    },
  };
}
