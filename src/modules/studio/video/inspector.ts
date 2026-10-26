import type { Aspect } from "../app";
import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { LOOKS, TRANSITION_GROUPS, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import {
  defaultFx, defaultPlace, findClip, layoutMain, maxDuration, maxTransition, mediaOf, MIN_CLIP, trimEnd,
  type Clip, type MediaClip, type Project, type TextAnim, type TextClip,
} from "./model";
import { TEXT_ANIMS, TEXT_FONTS } from "./text";

/**
 * The right panel: the selected clip's settings (picture, filter, speed, sound, text, animation),
 * or the project's (shape, background, frame rate) when nothing is selected. It's rebuilt when
 * the selection changes and only updates its values otherwise, so typing and dragging sliders
 * keep their focus.
 */

export interface InspectorHost {
  project(): Project;
  selectedId(): string | null;
  /** Changes the project; edits with the same `key` in a row make one undo step. */
  change(fn: (p: Project) => void, key: string): void;
  setAspect(aspect: Aspect): void;
}

type Sync = () => void;

const ASPECTS: [Aspect, string][] = [["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"], ["4:5", "4:5"]];

export class Inspector {
  readonly el: HTMLElement;
  private shown = "";
  private syncs: Sync[] = [];

  constructor(private host: InspectorHost) {
    this.el = h("aside", { class: "ve-inspector" });
    this.refresh(true);
  }

  /** Rebuilds when the selection (or the kind of thing selected) changed, else updates values. */
  refresh(force = false) {
    const id = this.host.selectedId();
    const p = this.host.project();
    const found = id ? findClip(p, id) : null;
    const key = found ? `${found.clip.id}:${found.track.kind}` : `project:${p.canvas.aspect}:${p.media.length}`;
    if (!force && key === this.shown) {
      for (const s of this.syncs) s();
      return;
    }
    this.shown = key;
    this.syncs = [];
    const scroll = this.el.scrollTop;
    if (!found) this.el.replaceChildren(...this.projectView());
    else if (found.clip.type === "text") this.el.replaceChildren(...this.textView(found.clip));
    else this.el.replaceChildren(...this.mediaView(found.clip, found.track.kind, found.index));
    this.el.scrollTop = scroll;
  }

  // ---- controls

  /** The selected clip as it is now (projects are replaced on undo and drags). */
  private live<T extends Clip>(id: string): T | null {
    return (findClip(this.host.project(), id)?.clip as T) ?? null;
  }

  private edit<T extends Clip>(id: string, key: string, fn: (c: T, p: Project) => void) {
    this.host.change((p) => {
      const c = findClip(p, id)?.clip as T | undefined;
      if (c) fn(c, p);
    }, `${id}:${key}`);
  }

  private slider(label: string, o: { min: number; max: number; step: number; get: () => number; set: (v: number) => void; format: (v: number) => string }): HTMLElement {
    const input = h("input", { type: "range", min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.get()) });
    const value = h("span", { class: "ve-value" }, o.format(o.get()));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      o.set(v);
      value.textContent = o.format(v);
    });
    input.addEventListener("dblclick", () => input.dispatchEvent(new Event("reset")));
    this.syncs.push(() => {
      if (document.activeElement === input) return;
      const v = o.get();
      input.value = String(v);
      value.textContent = o.format(v);
    });
    return h("div", { class: "ve-row" }, h("label", null, label), input, value);
  }

  private choice<V extends string>(label: string, options: readonly (readonly [V, string])[], get: () => V, set: (v: V) => void): HTMLElement {
    const buttons = options.map(([v, text]) => {
      const b = h("button", { type: "button", class: get() === v ? "active" : "", onclick: () => {
        set(v);
        for (const x of buttons) x.classList.toggle("active", x === b);
      } }, text);
      return b;
    });
    this.syncs.push(() => buttons.forEach((b, i) => b.classList.toggle("active", options[i][0] === get())));
    return h("div", { class: "ve-row" }, h("label", null, label), h("div", { class: "segmented ve-seg" }, ...buttons));
  }

  private select<V extends string>(label: string, options: readonly (readonly [V, string])[], get: () => V, set: (v: V) => void): HTMLElement {
    const el = h("select", { onchange: () => set(el.value as V) }, ...options.map(([v, text]) => h("option", { value: v }, text)));
    el.value = get();
    this.syncs.push(() => {
      if (document.activeElement !== el) el.value = get();
    });
    return h("div", { class: "ve-row" }, h("label", null, label), el);
  }

  private toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const el = h("input", { type: "checkbox", class: "switch", checked: get(), onchange: () => set(el.checked) });
    this.syncs.push(() => (el.checked = get()));
    return h("div", { class: "ve-row" }, h("label", null, label), h("span", { class: "spacer" }), el);
  }

  private color(label: string, get: () => string | null, set: (v: string | null) => void, optional: boolean): HTMLElement {
    const input = h("input", { type: "color", value: toHex(get() ?? "#ffffff"), oninput: () => set(input.value) });
    const on = optional ? h("input", { type: "checkbox", class: "switch", checked: get() !== null, onchange: () => set(on!.checked ? input.value : null) }) : null;
    this.syncs.push(() => {
      const v = get();
      if (v) input.value = toHex(v);
      if (on) on.checked = v !== null;
    });
    return h("div", { class: "ve-row" }, h("label", null, label), h("span", { class: "spacer" }), input, on);
  }

  private section(title: string, ...rows: (Node | null)[]): HTMLElement {
    return h("section", { class: "ve-section" }, h("h3", null, title), ...rows);
  }

  // ---- views

  private projectView(): Node[] {
    const p = this.host.project();
    const bg = () => this.host.project().canvas.background;
    const backgrounds = [["blur", "Blur"], ["#000000", "Black"], ["#ffffff", "White"]] as const;
    return [
      h("header", { class: "ve-inspector-head" }, icon("videoEdit", 16), h("span", null, "Project")),
      this.section("Canvas",
        this.choice("Shape", ASPECTS, () => this.host.project().canvas.aspect, (v) => this.host.setAspect(v)),
        this.choice("Background", backgrounds.map(([v, t]) => [v, t] as const), () => (backgrounds.some(([v]) => v === bg()) ? (bg() as "blur") : ("" as "blur")), (v) =>
          this.host.change((q) => (q.canvas.background = v), "background")),
        this.color("Colour", () => (bg() === "blur" ? null : bg()), (v) => this.host.change((q) => (q.canvas.background = v ?? "blur"), "background"), false),
        this.select("Frame rate", [["24", "24 fps"], ["25", "25 fps"], ["30", "30 fps"], ["50", "50 fps"], ["60", "60 fps"]] as const, () => String(this.host.project().canvas.fps) as "30", (v) =>
          this.host.change((q) => (q.canvas.fps = Number(v)), "fps")),
      ),
      h("p", { class: "ve-panel-note" }, `${p.media.length} file${p.media.length === 1 ? "" : "s"} · Select a clip on the timeline to change it.`),
    ];
  }

  private placement(id: string, isMain: boolean): HTMLElement {
    const c = () => this.live<MediaClip | TextClip>(id);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return this.section("Position",
      this.slider("Scale", { min: 0.1, max: 3, step: 0.01, get: () => c()?.place.scale ?? 1, set: (v) => this.edit(id, "scale", (x) => (x.place.scale = v)), format: pct }),
      this.slider("X", { min: -0.5, max: 1.5, step: 0.005, get: () => c()?.place.x ?? 0.5, set: (v) => this.edit(id, "x", (x) => (x.place.x = v)), format: (v) => pct(v - 0.5) }),
      this.slider("Y", { min: -0.5, max: 1.5, step: 0.005, get: () => c()?.place.y ?? 0.5, set: (v) => this.edit(id, "y", (x) => (x.place.y = v)), format: (v) => pct(v - 0.5) }),
      this.slider("Rotation", { min: -180, max: 180, step: 1, get: () => c()?.place.rotation ?? 0, set: (v) => this.edit(id, "rotation", (x) => (x.place.rotation = v)), format: (v) => `${Math.round(v)}°` }),
      this.slider("Opacity", { min: 0, max: 1, step: 0.01, get: () => c()?.place.opacity ?? 1, set: (v) => this.edit(id, "opacity", (x) => (x.place.opacity = v)), format: pct }),
      h("div", { class: "ve-row ve-row-buttons" }, h("button", { class: "btn small", type: "button", onclick: () =>
        this.edit(id, "reset", (x) => (x.place = { ...defaultPlace(), ...(isMain ? {} : { scale: x.place.scale }) })) }, "Reset position")),
    );
  }

  private mediaView(clip: MediaClip, trackKind: string, index: number): Node[] {
    const id = clip.id;
    const p = this.host.project();
    const m = mediaOf(p, clip.media);
    const c = () => this.live<MediaClip>(id);
    const visual = m && m.kind !== "audio" && trackKind !== "audio";
    const out: Node[] = [h("header", { class: "ve-inspector-head" }, icon(m?.kind === "audio" ? "music" : m?.kind === "image" ? "image" : "video", 16), h("span", { title: m?.path ?? "" }, m?.name ?? "Missing file"))];
    if (m?.note) out.push(h("p", { class: "ve-panel-note warn" }, m.note));
    if (m?.missing) out.push(h("p", { class: "ve-panel-note warn" }, `${m.path} can't be found.`));
    if (visual) {
      out.push(this.section("Picture",
        this.choice("Fit", [["fill", "Fill"], ["fit", "Fit"]] as const, () => c()?.fit ?? "fill", (v) => this.edit<MediaClip>(id, "fit", (x) => (x.fit = v))),
        m?.kind === "image" ? this.toggle("Ken Burns motion", () => c()?.motion ?? false, (v) => this.edit<MediaClip>(id, "motion", (x) => (x.motion = v))) : null,
      ));
      out.push(this.placement(id, trackKind === "main"));
      const looks: [LookId | "none", string][] = [["none", "None"], ...LOOKS.map((l) => [l.id, l.label] as [LookId, string])];
      const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
      out.push(this.section("Filter and adjust",
        this.select("Filter", looks, () => c()?.fx.look ?? "none", (v) => this.edit<MediaClip>(id, "look", (x) => (x.fx.look = v))),
        this.slider("Brightness", { min: -1, max: 1, step: 0.01, get: () => c()?.fx.brightness ?? 0, set: (v) => this.edit<MediaClip>(id, "brightness", (x) => (x.fx.brightness = v)), format: signed }),
        this.slider("Contrast", { min: -1, max: 1, step: 0.01, get: () => c()?.fx.contrast ?? 0, set: (v) => this.edit<MediaClip>(id, "contrast", (x) => (x.fx.contrast = v)), format: signed }),
        this.slider("Saturation", { min: -1, max: 1, step: 0.01, get: () => c()?.fx.saturation ?? 0, set: (v) => this.edit<MediaClip>(id, "saturation", (x) => (x.fx.saturation = v)), format: signed }),
        h("div", { class: "ve-row ve-row-buttons" }, h("button", { class: "btn small", type: "button", onclick: () => this.edit<MediaClip>(id, "fx-reset", (x) => (x.fx = defaultFx())) }, "Reset")),
      ));
    }
    if (m?.kind === "image") {
      out.push(this.section("Timing",
        this.slider("Duration", { min: 0.5, max: 30, step: 0.1, get: () => c()?.duration ?? 3, set: (v) => this.edit<MediaClip>(id, "duration", (x, q) => {
          trimEnd(q, x.id, x.start + v);
        }), format: (v) => `${v.toFixed(1)} s` })));
    } else if (m) {
      out.push(this.section("Speed",
        this.slider("Speed", { min: 0.25, max: 4, step: 0.05, get: () => c()?.speed ?? 1, set: (v) => this.edit<MediaClip>(id, "speed", (x, q) => {
          // The same part of the file plays, faster or slower.
          const span = x.duration * x.speed;
          x.speed = v;
          x.duration = Math.max(MIN_CLIP, Math.min(span / v, maxDuration(x, m)));
          if (trackKind === "main") layoutMain(q);
        }), format: (v) => `${v.toFixed(2)}×` }),
        h("div", { class: "ve-row ve-row-buttons" }, ...[0.5, 1, 1.5, 2].map((s) => h("button", { class: "btn small", type: "button", onclick: () => this.edit<MediaClip>(id, "speed-preset", (x, q) => {
          const span = x.duration * x.speed;
          x.speed = s;
          x.duration = Math.max(MIN_CLIP, Math.min(span / s, maxDuration(x, m)));
          if (trackKind === "main") layoutMain(q);
        }) }, `${s}×`))),
      ));
    }
    if (m?.audio) {
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      out.push(this.section("Sound",
        this.slider("Volume", { min: 0, max: 2, step: 0.01, get: () => c()?.volume ?? 1, set: (v) => this.edit<MediaClip>(id, "volume", (x) => (x.volume = v)), format: pct }),
        this.slider("Fade in", { min: 0, max: 5, step: 0.1, get: () => c()?.fadeIn ?? 0, set: (v) => this.edit<MediaClip>(id, "fadeIn", (x) => (x.fadeIn = v)), format: (v) => `${v.toFixed(1)} s` }),
        this.slider("Fade out", { min: 0, max: 5, step: 0.1, get: () => c()?.fadeOut ?? 0, set: (v) => this.edit<MediaClip>(id, "fadeOut", (x) => (x.fadeOut = v)), format: (v) => `${v.toFixed(1)} s` }),
      ));
    }
    if (trackKind === "main" && index > 0) {
      const kinds = TRANSITION_GROUPS.flatMap((g) => g.items.map(([k, l]) => [k, l] as [TransitionKind, string]));
      const options: [TransitionKind | "none", string][] = [["none", "None"], ...kinds];
      out.push(this.section("Transition in",
        this.select("Kind", options, () => c()?.transition?.kind ?? "none", (v) => this.edit<MediaClip>(id, "transition", (x, q) => {
          if (v === "none") delete x.transition;
          else x.transition = { kind: v, duration: x.transition?.duration ?? 0.6 };
          layoutMain(q);
        })),
        this.slider("Length", { min: 0.2, max: 2, step: 0.1, get: () => c()?.transition?.duration ?? 0.6, set: (v) => this.edit<MediaClip>(id, "transition-length", (x, q) => {
          if (!x.transition) return;
          const i = q.tracks[0].clips.findIndex((k) => k.id === x.id);
          x.transition.duration = Math.min(v, maxTransition(q.tracks[0], i));
        }), format: (v) => `${v.toFixed(1)} s` }),
      ));
    }
    return out;
  }

  private textView(clip: TextClip): Node[] {
    const id = clip.id;
    const c = () => this.live<TextClip>(id);
    const area = h("textarea", { class: "ve-textarea", rows: 3, value: clip.text, spellcheck: "true" });
    area.addEventListener("input", () => this.edit<TextClip>(id, "text", (x) => (x.text = area.value)));
    this.syncs.push(() => {
      if (document.activeElement !== area) area.value = c()?.text ?? "";
    });
    const style = <K extends keyof TextClip["style"]>(k: K, v: TextClip["style"][K]) => this.edit<TextClip>(id, `style-${String(k)}`, (x) => (x.style[k] = v));
    const fonts = TEXT_FONTS.map(([v, l]) => [v, l] as [string, string]);
    if (!fonts.some(([v]) => v === clip.style.font)) fonts.push([clip.style.font, clip.style.font]);
    return [
      h("header", { class: "ve-inspector-head" }, icon("textBox", 16), h("span", null, "Text")),
      this.section("Text", area,
        this.select("Font", fonts, () => c()?.style.font ?? "sans-serif", (v) => style("font", v)),
        this.slider("Size", { min: 12, max: 200, step: 1, get: () => c()?.style.size ?? 56, set: (v) => style("size", v), format: (v) => String(Math.round(v)) }),
        this.choice("Style", [["regular", "Regular"], ["bold", "Bold"], ["italic", "Italic"]] as const,
          () => (c()?.style.italic ? "italic" : c()?.style.bold ? "bold" : "regular"),
          (v) => this.edit<TextClip>(id, "style-weight", (x) => {
            x.style.bold = v === "bold";
            x.style.italic = v === "italic";
          })),
        this.choice("Align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]] as const, () => c()?.style.align ?? "center", (v) => style("align", v)),
        this.color("Colour", () => c()?.style.color ?? "#ffffff", (v) => style("color", v ?? "#ffffff"), false),
        this.color("Outline", () => c()?.style.stroke ?? null, (v) => this.edit<TextClip>(id, "style-stroke", (x) => {
          x.style.stroke = v;
          if (v && !x.style.strokeWidth) x.style.strokeWidth = 90;
        }), true),
        this.color("Box", () => c()?.style.box ?? null, (v) => style("box", v ? withAlpha(v, 0.7) : null), true),
        this.toggle("Shadow / glow", () => c()?.style.shadow ?? false, (v) => style("shadow", v)),
      ),
      this.section("Animation",
        this.select("In", TEXT_ANIMS, () => c()?.animIn ?? "none", (v: TextAnim) => this.edit<TextClip>(id, "animIn", (x) => (x.animIn = v))),
        this.select("Out", TEXT_ANIMS.filter(([a]) => a !== "typewriter"), () => c()?.animOut ?? "none", (v: TextAnim) => this.edit<TextClip>(id, "animOut", (x) => (x.animOut = v))),
        this.slider("Duration", { min: 0.5, max: 30, step: 0.1, get: () => c()?.duration ?? 3, set: (v) => this.edit<TextClip>(id, "duration", (x, q) => {
          trimEnd(q, x.id, x.start + v);
        }), format: (v) => `${v.toFixed(1)} s` }),
      ),
      this.placement(id, false),
    ];
  }
}

function withAlpha(hex: string, alpha: number): string {
  const v = parseInt(toHex(hex).slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return "#000000";
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}
