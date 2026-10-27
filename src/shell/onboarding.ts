import { ACCENTS, type ThemeMode } from "../appearance";
import type { Config } from "../config";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { MODULE_IDS, type ModuleId } from "./module";
import { MODULES } from "./registry";

/** What the first-run wizard needs from the shell. */
export interface OnboardingHost {
  readonly config: Config;
  /** Applies the appearance everywhere and saves it. */
  appearanceChanged(): void;
  /** Turns features on or off to match `features` (at least one is on). */
  applyFeatures(features: Record<ModuleId, boolean>): void;
}

const THEMES: [ThemeMode, string][] = [["light", "Light"], ["dark", "Dark"], ["system", "System"]];

/** The first-run wizard: a glass sheet over the app. Theme and accent apply live; features apply at the end. */
export class Onboarding {
  readonly el = h("div", { class: "ob-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Welcome to Zazabor" });
  private body = h("div", { class: "ob-body" });
  private dots = h("div", { class: "ob-dots" });
  private back = h("button", { class: "btn ghost", type: "button" }, icon("chevronLeft", 15), "Back");
  private next = h("button", { class: "btn primary", type: "button" });
  private step = 0;
  private features: Record<ModuleId, boolean>;
  private done: () => void = () => {};
  private readonly steps = [
    { title: "Welcome", render: () => this.welcome() },
    { title: "Theme", render: () => this.theme() },
    { title: "Features", render: () => this.featureStep() },
    { title: "Done", render: () => this.finish() },
  ];

  constructor(private readonly host: OnboardingHost) {
    this.features = { ...host.config.features };
    this.back.addEventListener("click", () => this.go(-1));
    this.next.addEventListener("click", () => (this.step === this.steps.length - 1 ? this.complete() : this.go(1)));
    for (let i = 0; i < this.steps.length; i++) this.dots.append(h("span", { class: "ob-dot" }));
    const sheet = h("div", { class: "ob-sheet" }, this.body, h("footer", { class: "ob-foot" }, this.back, this.dots, this.next));
    this.el.append(sheet);
    this.el.addEventListener("keydown", (e) => {
      // Esc does nothing until the wizard is done; arrows page through it.
      if (e.key === "Escape") e.preventDefault();
      else if (e.key === "ArrowRight" && !(e.target instanceof HTMLInputElement)) this.next.click();
      else if (e.key === "ArrowLeft" && !(e.target instanceof HTMLInputElement) && this.step > 0) this.go(-1);
    });
  }

  /** Shows the wizard; resolves when the user finishes it. */
  run(): Promise<void> {
    document.body.append(this.el);
    this.render();
    return new Promise((resolve) => (this.done = resolve));
  }

  private go(delta: number) {
    this.step = Math.max(0, Math.min(this.steps.length - 1, this.step + delta));
    this.render();
  }

  private render() {
    const last = this.step === this.steps.length - 1;
    this.body.replaceChildren(this.steps[this.step].render());
    this.back.style.visibility = this.step === 0 ? "hidden" : "visible";
    this.next.replaceChildren(...(last ? [icon("check", 16), "Start using Zazabor"] : [this.step === 0 ? "Get started" : "Next", icon("chevronRight", 15)]));
    [...this.dots.children].forEach((dot, i) => {
      dot.classList.toggle("active", i === this.step);
      dot.classList.toggle("past", i < this.step);
    });
    this.next.focus();
  }

  private complete() {
    this.host.applyFeatures(this.features);
    this.host.config.onboarded = true;
    this.host.appearanceChanged();
    this.el.classList.add("leaving");
    setTimeout(() => this.el.remove(), 260);
    this.done();
  }

  private heading(title: string, sub: string) {
    return h("header", { class: "ob-head" }, h("h1", null, title), h("p", null, sub));
  }

  private welcome() {
    return h(
      "div",
      { class: "ob-step ob-center" },
      h("img", { class: "ob-logo", src: "/logo.svg", alt: "", width: 96, height: 96 }),
      h("h1", { class: "ob-hero" }, "Welcome to Zazabor"),
      h("p", { class: "ob-lead" }, "Your files, photos and videos in one calm, beautiful place. Let's make it yours in three quick steps."),
    );
  }

  private theme() {
    const appearance = this.host.config.appearance;
    const cards = h("div", { class: "ob-themes" });
    const swatches = h("div", { class: "ap-swatches" });
    const sync = () => {
      cards.querySelectorAll<HTMLElement>(".ob-theme").forEach((card) => card.classList.toggle("active", card.dataset.mode === appearance.mode));
      swatches.querySelectorAll<HTMLElement>(".ap-swatch, .ap-color").forEach((b) => b.classList.toggle("active", b.dataset.color === appearance.accent || (b.classList.contains("ap-color") && !ACCENTS.includes(appearance.accent))));
    };
    const changed = () => {
      this.host.appearanceChanged();
      sync();
    };
    for (const [mode, label] of THEMES) {
      const card = h(
        "button",
        { type: "button", class: "ob-theme", "data-mode": mode, "aria-label": label, onclick: () => ((appearance.mode = mode), changed()) },
        h("div", { class: `ob-preview ${mode}` }, this.mock(mode === "dark" ? "dark" : "light"), mode === "system" ? this.mock("dark") : null),
        h("span", { class: "ob-theme-label" }, label, h("span", { class: "ob-theme-check" }, icon("check", 12))),
      );
      cards.append(card);
    }
    for (const color of ACCENTS) {
      swatches.append(h("button", { type: "button", class: "ap-swatch", title: color, "data-color": color, style: { background: color }, onclick: () => ((appearance.accent = color), changed()) }));
    }
    const picker = h("input", { type: "color", class: "ap-color", title: "Any colour", "data-color": "" });
    picker.value = appearance.accent;
    picker.addEventListener("input", () => ((appearance.accent = picker.value), changed()));
    swatches.append(picker);
    sync();
    return h(
      "div",
      { class: "ob-step" },
      this.heading("Make it yours", "Pick a theme and an accent colour. You can change both any time in Settings."),
      cards,
      h("div", { class: "ob-accent" }, h("span", { class: "ob-section" }, "Accent"), swatches),
    );
  }

  /** A tiny stand-in for the app window, drawn in a fixed light or dark palette. */
  private mock(palette: "light" | "dark") {
    return h(
      "div",
      { class: `ob-mock ${palette}` },
      h("div", { class: "ob-mock-side" }, h("span", { class: "ob-mock-pill" }), h("span"), h("span")),
      h("div", { class: "ob-mock-main" }, h("div", { class: "ob-mock-bar" }), h("div", { class: "ob-mock-tiles" }, h("span"), h("span"), h("span"), h("span"))),
    );
  }

  private featureStep() {
    const cards = h("div", { class: "ob-features" });
    const sync = () => {
      const on = MODULE_IDS.filter((id) => this.features[id]);
      cards.querySelectorAll<HTMLButtonElement>(".ob-feature").forEach((card) => {
        const id = card.dataset.id as ModuleId;
        card.classList.toggle("active", this.features[id]);
        card.setAttribute("aria-checked", String(this.features[id]));
        card.disabled = on.length === 1 && on[0] === id;
      });
    };
    for (const id of MODULE_IDS) {
      const meta = MODULES[id];
      cards.append(
        h(
          "button",
          { type: "button", class: "ob-feature", role: "switch", "data-id": id, onclick: () => ((this.features[id] = !this.features[id]), sync()) },
          h("span", { class: "ob-feature-icon" }, icon(meta.icon, 24)),
          h("span", { class: "ob-feature-text" }, h("strong", null, meta.title), h("span", null, meta.blurb)),
          h("span", { class: "ob-feature-check" }, icon("check", 14)),
        ),
      );
    }
    sync();
    return h(
      "div",
      { class: "ob-step" },
      this.heading("Choose your features", "Turn on what you need. Anything you skip stays out of the way, and you can add it back later."),
      cards,
    );
  }

  private finish() {
    return h(
      "div",
      { class: "ob-step ob-center" },
      h("div", { class: "ob-done" }, icon("sparkles", 40)),
      h("h1", { class: "ob-hero" }, "You're all set"),
      h("p", { class: "ob-lead" }, "Zazabor is ready. Settings, with every choice you just made, is always one click away at the bottom of the rail."),
    );
  }
}
