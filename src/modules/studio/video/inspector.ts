import type { Aspect } from "../app";
import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { LOOKS, TRANSITION_GROUPS, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import {
  CURVE_PRESETS, curveMean, defaultFrame, defaultFx, defaultMask, defaultPlace, findClip, hasKeys, keyAt, keyTimes, layoutMain, maxDuration,
  maxTransition, mediaOf, MIN_CLIP, propAt, removeKey, setKey, setProp, sourceSpan, trimEnd,
  type Clip, type CurvePreset, type Ease, type EffectId, type KeyProp, type MediaClip, type Project, type TextAnim, type TextClip,
} from "./model";
import { TEXT_ANIMS, TEXT_FONTS } from "./text";

/**
 * The right panel: the selected clip's settings (picture, keyframes, filter and effects, colour
 * table, chroma key, mask, frame, speed, sound, text, animation), or the project's (shape,
 * background, frame rate) when nothing is selected. It's rebuilt when the selection changes and
 * only updates its values otherwise (also as the playhead moves, for keyframed values), so typing
 * and dragging sliders keep their focus.
 */

export interface InspectorHost {
  project(): Project;
  selectedId(): string | null;
  /** Changes the project; edits with the same `key` in a row make one undo step. */
  change(fn: (p: Project) => void, key: string): void;
  setAspect(aspect: Aspect): void;
  /** The playhead. */
  time(): number;
  seek(t: number): void;
  /** Asks for a .cube file for the clip. */
  loadLut(id: string): void;
  /** Picks the key colour by clicking the preview. */
  pickKeyColor(id: string): void;
  /** Freezes the frame under the playhead into a clip of its own. */
  freezeFrame(): void;
  /** Marks the beats of an audio clip from its sound. */
  markBeats(id: string): void;
}

type Sync = () => void;

const ASPECTS: [Aspect, string][] = [["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"], ["4:5", "4:5"]];
const EASES: [Ease, string][] = [["smooth", "Smooth"], ["linear", "Linear"], ["in", "Ease in"], ["out", "Ease out"], ["hold", "Hold"]];
const EFFECTS: [EffectId, string][] = [
  ["none", "None"], ["shake", "Shake"], ["pulse", "Zoom pulse"], ["glitch", "Glitch"], ["rgb", "RGB split"], ["vhs", "VHS"],
  ["mirror", "Mirror"], ["flash", "Flash in"], ["blurin", "Blur in"],
];
/** Picture-in-picture spots: centre and scale. */
const PIP_SPOTS: [string, number, number][] = [["Top left", 0.27, 0.2], ["Top right", 0.73, 0.2], ["Bottom left", 0.27, 0.8], ["Bottom right", 0.73, 0.8], ["Centre", 0.5, 0.5]];

export class Inspector {
  readonly el: HTMLElement;
  private shown = "";
  private syncs: Sync[] = [];
  private lastTimeSync = 0;

  constructor(private host: InspectorHost) {
    this.el = h("aside", { class: "ve-inspector" });
    this.refresh(true);
  }

  /** Rebuilds when the selection (or the kind of thing selected) changed, else updates values. */
  refresh(force = false) {
    const id = this.host.selectedId();
    const p = this.host.project();
    const found = id ? findClip(p, id) : null;
    const c = found?.clip;
    const shape = c?.type === "media" ? `${c.freeze !== undefined}:${!!c.fx.key}:${!!c.mask}:${!!c.frame}:${!!c.fx.lut}:${c.fx.effect !== "none"}:${!!c.curve}` : "";
    const key = found ? `${found.clip.id}:${found.track.kind}:${shape}` : `project:${p.canvas.aspect}:${p.media.length}`;
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

  /** The playhead moved: keyframed values and the diamonds follow (at most ten times a second). */
  timeChanged(playing: boolean) {
    const now = performance.now();
    if (playing && now - this.lastTimeSync < 100) return;
    this.lastTimeSync = now;
    for (const s of this.syncs) s();
  }

  // ---- controls

  /** The selected clip as it is now (projects are replaced on undo and drags). */
  private live<T extends Clip>(id: string): T | null {
    return (findClip(this.host.project(), id)?.clip as T) ?? null;
  }

  /** Seconds into the clip at the playhead, kept inside it. */
  private local(c: Clip): number {
    return Math.max(0, Math.min(c.duration, this.host.time() - c.start));
  }

  private edit<T extends Clip>(id: string, key: string, fn: (c: T, p: Project) => void) {
    this.host.change((p) => {
      const c = findClip(p, id)?.clip as T | undefined;
      if (c) fn(c, p);
    }, `${id}:${key}`);
  }

  private slider(label: string, o: { min: number; max: number; step: number; get: () => number; set: (v: number) => void; format: (v: number) => string }, keyed?: { id: string; prop: KeyProp }): HTMLElement {
    const input = h("input", { type: "range", min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.get()) });
    const value = h("span", { class: "ve-value" }, o.format(o.get()));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      o.set(v);
      value.textContent = o.format(v);
    });
    let diamond: HTMLButtonElement | null = null;
    if (keyed) {
      diamond = h("button", { class: "ve-key", type: "button", title: "Add a keyframe at the playhead", "aria-label": `Keyframe ${label}`, onclick: () => this.toggleKey(keyed.id, keyed.prop) }, icon("veKey", 12));
    }
    this.syncs.push(() => {
      if (diamond && keyed) {
        const c = this.live(keyed.id);
        const on = c ? !!keyAt(c, keyed.prop, this.local(c)) : false;
        diamond.classList.toggle("on", on);
        diamond.classList.toggle("has", !!c && hasKeys(c, keyed.prop));
        diamond.title = on ? "Remove the keyframe at the playhead" : "Add a keyframe at the playhead";
      }
      if (document.activeElement === input) return;
      const v = o.get();
      input.value = String(v);
      value.textContent = o.format(v);
    });
    return h("div", { class: `ve-row${keyed ? " keyed" : ""}` }, diamond, h("label", null, label), input, value);
  }

  private toggleKey(id: string, prop: KeyProp) {
    this.edit(id, `key-${prop}`, (c) => {
      const local = this.local(c);
      if (keyAt(c, prop, local)) removeKey(c, prop, local);
      else setKey(c, prop, local, propAt(c, prop, local));
    });
  }

  /** A keyable slider: its value at the playhead, edited there. */
  private keyedSlider(id: string, prop: KeyProp, label: string, o: { min: number; max: number; step: number; format: (v: number) => string }): HTMLElement {
    return this.slider(label, {
      ...o,
      get: () => {
        const c = this.live(id);
        return c ? propAt(c, prop, this.local(c)) : 0;
      },
      set: (v) => this.edit(id, prop, (x) => setProp(x, prop, this.local(x), v)),
    }, { id, prop });
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

  private color(label: string, get: () => string | null, set: (v: string | null) => void, optional: boolean, extra?: Node): HTMLElement {
    const input = h("input", { type: "color", value: toHex(get() ?? "#ffffff"), oninput: () => set(input.value) });
    const on = optional ? h("input", { type: "checkbox", class: "switch", checked: get() !== null, onchange: () => set(on!.checked ? input.value : null) }) : null;
    this.syncs.push(() => {
      const v = get();
      if (v && document.activeElement !== input) input.value = toHex(v);
      if (on) on.checked = v !== null;
    });
    return h("div", { class: "ve-row" }, h("label", null, label), h("span", { class: "spacer" }), extra ?? null, input, on);
  }

  private buttons(...items: [string, () => void, boolean?][]): HTMLElement {
    return h("div", { class: "ve-row ve-row-buttons" }, ...items.map(([text, run, disabled]) => h("button", { class: "btn small", type: "button", disabled: !!disabled, onclick: run }, text)));
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

  /** Keyframe tools: step between keyframes, and the ease of the ones at the playhead. */
  private keyTools(id: string): HTMLElement {
    const c = () => this.live(id);
    const nav = (dir: -1 | 1) => {
      const clip = c();
      if (!clip) return;
      const local = this.local(clip);
      const times = keyTimes(clip);
      const next = dir > 0 ? times.find((t) => t > local + 1e-3) : [...times].reverse().find((t) => t < local - 1e-3);
      if (next !== undefined) this.host.seek(clip.start + next);
    };
    const ease = h("select", { onchange: () => this.edit(id, "ease", (x) => {
      const local = this.local(x);
      for (const list of Object.values(x.keys ?? {})) for (const k of list ?? []) if (Math.abs(k.t - local) <= 1 / 60) k.ease = ease.value as Ease;
    }) }, ...EASES.map(([v, t]) => h("option", { value: v }, t)));
    const count = h("span", { class: "ve-value" });
    const row = h("div", { class: "ve-row ve-key-tools" },
      h("button", { class: "icon-btn small", type: "button", title: "Previous keyframe", onclick: () => nav(-1) }, icon("chevronLeft", 15)),
      h("button", { class: "icon-btn small", type: "button", title: "Next keyframe", onclick: () => nav(1) }, icon("chevronRight", 15)),
      h("label", null, "Ease"), ease, count);
    this.syncs.push(() => {
      const clip = c();
      const local = clip ? this.local(clip) : 0;
      const here = Object.values(clip?.keys ?? {}).flatMap((l) => l ?? []).find((k) => Math.abs(k.t - local) <= 1 / 60);
      ease.disabled = !here;
      if (here && document.activeElement !== ease) ease.value = here.ease;
      const n = clip ? keyTimes(clip).length : 0;
      count.textContent = n ? `${n} key${n === 1 ? "" : "s"}` : "";
      row.hidden = !n;
    });
    return row;
  }

  private placement(id: string, isMain: boolean): HTMLElement {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return this.section("Position",
      h("p", { class: "ve-panel-note" }, "◆ adds a keyframe at the playhead; with keyframes, moving a slider changes the one there."),
      this.keyedSlider(id, "scale", "Scale", { min: 0.1, max: 3, step: 0.01, format: pct }),
      this.keyedSlider(id, "x", "X", { min: -0.5, max: 1.5, step: 0.005, format: (v) => pct(v - 0.5) }),
      this.keyedSlider(id, "y", "Y", { min: -0.5, max: 1.5, step: 0.005, format: (v) => pct(v - 0.5) }),
      this.keyedSlider(id, "rotation", "Rotation", { min: -180, max: 180, step: 1, format: (v) => `${Math.round(v)}°` }),
      this.keyedSlider(id, "opacity", "Opacity", { min: 0, max: 1, step: 0.01, format: pct }),
      this.keyTools(id),
      this.buttons(["Reset position", () => this.edit(id, "reset", (x) => {
        x.place = { ...defaultPlace(), ...(isMain ? {} : { scale: x.place.scale }) };
        if (x.keys) for (const prop of ["x", "y", "scale", "rotation", "opacity"] as KeyProp[]) delete x.keys[prop];
        if (x.keys && !Object.keys(x.keys).length) delete x.keys;
      })]),
    );
  }

  private mediaView(clip: MediaClip, trackKind: string, index: number): Node[] {
    const id = clip.id;
    const p = this.host.project();
    const m = mediaOf(p, clip.media);
    const c = () => this.live<MediaClip>(id);
    const visual = m && m.kind !== "audio" && trackKind !== "audio";
    const frozen = clip.freeze !== undefined;
    const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const head = frozen ? "Freeze frame" : clip.role === "voice" ? "Voice-over" : m?.name ?? "Missing file";
    const out: Node[] = [h("header", { class: "ve-inspector-head" }, icon(m?.kind === "audio" ? (clip.role === "voice" ? "veMic" : "music") : frozen ? "snowflake" : m?.kind === "image" ? "image" : "video", 16), h("span", { title: m?.path ?? "" }, head))];
    if (m?.note) out.push(h("p", { class: "ve-panel-note warn" }, m.note));
    if (m?.missing) out.push(h("p", { class: "ve-panel-note warn" }, `${m.path} can't be found.`));
    if (visual) {
      out.push(this.section("Picture",
        this.choice("Fit", [["fill", "Fill"], ["fit", "Fit"]] as const, () => c()?.fit ?? "fill", (v) => this.edit<MediaClip>(id, "fit", (x) => (x.fit = v))),
        m?.kind === "image" ? this.toggle("Ken Burns motion", () => c()?.motion ?? false, (v) => this.edit<MediaClip>(id, "motion", (x) => (x.motion = v))) : null,
      ));
      out.push(this.placement(id, trackKind === "main"));
      const looks: [LookId | "none", string][] = [["none", "None"], ...LOOKS.map((l) => [l.id, l.label] as [LookId, string])];
      const lutName = h("span", { class: "ve-value ve-lut-name" });
      this.syncs.push(() => (lutName.textContent = c()?.fx.lut?.name ?? "None"));
      out.push(this.section("Filter and adjust",
        this.select("Filter", looks, () => c()?.fx.look ?? "none", (v) => this.edit<MediaClip>(id, "look", (x) => (x.fx.look = v))),
        this.slider("Brightness", { min: -1, max: 1, step: 0.01, get: () => c()?.fx.brightness ?? 0, set: (v) => this.edit<MediaClip>(id, "brightness", (x) => (x.fx.brightness = v)), format: signed }),
        this.slider("Contrast", { min: -1, max: 1, step: 0.01, get: () => c()?.fx.contrast ?? 0, set: (v) => this.edit<MediaClip>(id, "contrast", (x) => (x.fx.contrast = v)), format: signed }),
        this.slider("Saturation", { min: -1, max: 1, step: 0.01, get: () => c()?.fx.saturation ?? 0, set: (v) => this.edit<MediaClip>(id, "saturation", (x) => (x.fx.saturation = v)), format: signed }),
        h("div", { class: "ve-row" }, h("label", null, "Colour table"), lutName,
          h("button", { class: "btn small", type: "button", title: "Load a .cube LUT", onclick: () => this.host.loadLut(id) }, clip.fx.lut ? "Change…" : "Load .cube…")),
        clip.fx.lut ? this.slider("Strength", { min: 0, max: 1, step: 0.01, get: () => c()?.fx.lut?.strength ?? 1, set: (v) => this.edit<MediaClip>(id, "lut-strength", (x) => x.fx.lut && (x.fx.lut.strength = v)), format: pct }) : null,
        this.buttons(["Reset", () => this.edit<MediaClip>(id, "fx-reset", (x) => {
          const keep = x.fx;
          x.fx = { ...defaultFx(), effect: keep.effect, amount: keep.amount, key: keep.key, blur: keep.blur, sharpen: keep.sharpen, vignette: keep.vignette, grain: keep.grain };
        })], ...(clip.fx.lut ? [["Remove table", () => this.edit<MediaClip>(id, "lut", (x) => (x.fx.lut = null))] as [string, () => void]] : [])),
      ));
      out.push(this.section("Effects",
        this.select("Effect", EFFECTS, () => c()?.fx.effect ?? "none", (v) => this.edit<MediaClip>(id, "effect", (x) => (x.fx.effect = v))),
        clip.fx.effect !== "none" ? this.slider("Amount", { min: 0, max: 1, step: 0.01, get: () => c()?.fx.amount ?? 0.6, set: (v) => this.edit<MediaClip>(id, "amount", (x) => (x.fx.amount = v)), format: pct }) : null,
        this.slider("Blur", { min: 0, max: 1, step: 0.01, get: () => c()?.fx.blur ?? 0, set: (v) => this.edit<MediaClip>(id, "blur", (x) => (x.fx.blur = v)), format: pct }),
        this.slider("Sharpen", { min: 0, max: 1, step: 0.01, get: () => c()?.fx.sharpen ?? 0, set: (v) => this.edit<MediaClip>(id, "sharpen", (x) => (x.fx.sharpen = v)), format: pct }),
        this.slider("Vignette", { min: 0, max: 1, step: 0.01, get: () => c()?.fx.vignette ?? 0, set: (v) => this.edit<MediaClip>(id, "vignette", (x) => (x.fx.vignette = v)), format: pct }),
        this.slider("Grain", { min: 0, max: 1, step: 0.01, get: () => c()?.fx.grain ?? 0, set: (v) => this.edit<MediaClip>(id, "grain", (x) => (x.fx.grain = v)), format: pct }),
      ));
      const key = () => c()?.fx.key ?? null;
      out.push(this.section("Chroma key",
        this.toggle("Remove a colour", () => !!key(), (v) => this.edit<MediaClip>(id, "key", (x) => (x.fx.key = v ? { color: "#00b140", tolerance: 0.35, softness: 0.25, spill: 0.4 } : null))),
        ...(clip.fx.key ? [
          this.color("Colour", () => key()?.color ?? "#00b140", (v) => this.edit<MediaClip>(id, "key-color", (x) => x.fx.key && (x.fx.key.color = v ?? "#00b140")), false,
            h("button", { class: "icon-btn small", type: "button", title: "Pick it from the preview", "aria-label": "Pick the colour from the preview", onclick: () => this.host.pickKeyColor(id) }, icon("phEyedropper", 15))),
          this.slider("Strength", { min: 0, max: 1, step: 0.01, get: () => key()?.tolerance ?? 0.35, set: (v) => this.edit<MediaClip>(id, "key-tol", (x) => x.fx.key && (x.fx.key.tolerance = v)), format: pct }),
          this.slider("Edge", { min: 0, max: 1, step: 0.01, get: () => key()?.softness ?? 0.25, set: (v) => this.edit<MediaClip>(id, "key-soft", (x) => x.fx.key && (x.fx.key.softness = v)), format: pct }),
          this.slider("Spill", { min: 0, max: 1, step: 0.01, get: () => key()?.spill ?? 0.4, set: (v) => this.edit<MediaClip>(id, "key-spill", (x) => x.fx.key && (x.fx.key.spill = v)), format: pct }),
        ] : []),
      ));
      const mask = () => c()?.mask ?? null;
      const mset = (k: "x" | "y" | "w" | "h" | "feather", v: number) => this.edit<MediaClip>(id, `mask-${k}`, (x) => x.mask && (x.mask[k] = v));
      out.push(this.section("Mask",
        this.select("Shape", [["none", "None"], ["circle", "Circle"], ["rect", "Rectangle"]] as const, () => mask()?.shape ?? "none", (v) => this.edit<MediaClip>(id, "mask", (x) => {
          x.mask = v === "none" ? null : { ...(x.mask ?? defaultMask()), shape: v };
        })),
        ...(clip.mask ? [
          this.slider("X", { min: 0, max: 1, step: 0.005, get: () => mask()?.x ?? 0.5, set: (v) => mset("x", v), format: (v) => pct(v - 0.5) }),
          this.slider("Y", { min: 0, max: 1, step: 0.005, get: () => mask()?.y ?? 0.5, set: (v) => mset("y", v), format: (v) => pct(v - 0.5) }),
          this.slider("Width", { min: 0.02, max: 3, step: 0.005, get: () => mask()?.w ?? 0.6, set: (v) => mset("w", v), format: pct }),
          this.slider("Height", { min: 0.02, max: 3, step: 0.005, get: () => mask()?.h ?? 0.6, set: (v) => mset("h", v), format: pct }),
          this.slider("Feather", { min: 0, max: 0.3, step: 0.005, get: () => mask()?.feather ?? 0.04, set: (v) => mset("feather", v), format: pct }),
          this.toggle("Invert", () => mask()?.invert ?? false, (v) => this.edit<MediaClip>(id, "mask-invert", (x) => x.mask && (x.mask.invert = v))),
        ] : []),
      ));
      const frame = () => c()?.frame ?? null;
      out.push(this.section(trackKind === "overlay" ? "Picture in picture" : "Frame",
        trackKind === "overlay" ? h("div", { class: "ve-row ve-row-buttons" }, ...PIP_SPOTS.map(([label, x, y]) => h("button", { class: "btn small", type: "button", onclick: () => this.edit<MediaClip>(id, "pip", (k) => {
          const scale = label === "Centre" ? 0.6 : 0.4;
          setProp(k, "x", this.local(k), x);
          setProp(k, "y", this.local(k), y);
          setProp(k, "scale", this.local(k), scale);
          k.fit = "fit";
          k.frame ??= defaultFrame();
        }) }, label))) : null,
        this.toggle("Rounded frame", () => !!frame(), (v) => this.edit<MediaClip>(id, "frame", (x) => (x.frame = v ? defaultFrame() : null))),
        ...(clip.frame ? [
          this.slider("Corners", { min: 0, max: 0.5, step: 0.005, get: () => frame()?.radius ?? 0.08, set: (v) => this.edit<MediaClip>(id, "frame-r", (x) => x.frame && (x.frame.radius = v)), format: pct }),
          this.slider("Border", { min: 0, max: 30, step: 0.5, get: () => frame()?.border ?? 6, set: (v) => this.edit<MediaClip>(id, "frame-b", (x) => x.frame && (x.frame.border = v)), format: (v) => v.toFixed(1) }),
          this.color("Border colour", () => frame()?.color ?? "#ffffff", (v) => this.edit<MediaClip>(id, "frame-c", (x) => x.frame && (x.frame.color = v ?? "#ffffff")), false),
          this.slider("Shadow", { min: 0, max: 1, step: 0.01, get: () => frame()?.shadow ?? 0.5, set: (v) => this.edit<MediaClip>(id, "frame-s", (x) => x.frame && (x.frame.shadow = v)), format: pct }),
        ] : []),
      ));
    }
    if (m?.kind === "image" || frozen) {
      out.push(this.section("Timing",
        this.slider("Duration", { min: 0.5, max: 30, step: 0.1, get: () => c()?.duration ?? 3, set: (v) => this.edit<MediaClip>(id, "duration", (x, q) => {
          trimEnd(q, x.id, x.start + v);
        }), format: (v) => `${v.toFixed(1)} s` })));
    } else if (m) {
      const curves: [CurvePreset | "none", string][] = [["none", "None"], ...Object.entries(CURVE_PRESETS).map(([k, v]) => [k, v.label] as [CurvePreset, string])];
      const setSpeed = (x: MediaClip, q: Project, v: number) => {
        // The same part of the file plays, faster or slower.
        const span = sourceSpan(x);
        x.speed = v;
        x.duration = Math.max(MIN_CLIP, Math.min(span / (v * (x.curve ? curveMean(x) : 1)), maxDuration(x, m)));
        if (trackKind === "main") layoutMain(q);
      };
      out.push(this.section("Speed",
        this.slider("Speed", { min: 0.25, max: 4, step: 0.05, get: () => c()?.speed ?? 1, set: (v) => this.edit<MediaClip>(id, "speed", (x, q) => setSpeed(x, q, v)), format: (v) => `${v.toFixed(2)}×` }),
        h("div", { class: "ve-row ve-row-buttons" }, ...[0.5, 1, 1.5, 2].map((s) => h("button", { class: "btn small", type: "button", onclick: () => this.edit<MediaClip>(id, "speed-preset", (x, q) => setSpeed(x, q, s)) }, `${s}×`))),
        m.kind === "video" ? this.select("Curve", curves, () => c()?.curve?.preset ?? "none", (v) => this.edit<MediaClip>(id, "curve", (x, q) => {
          // The clip keeps playing the same part of its file; its length follows the curve.
          const span = sourceSpan(x);
          x.curve = v === "none" ? null : { preset: v, points: [...CURVE_PRESETS[v].points] };
          x.duration = Math.max(MIN_CLIP, span / (x.speed * curveMean(x)));
          if (trackKind === "main") layoutMain(q);
        })) : null,
        m.kind === "video" ? this.toggle("Reverse", () => !!c()?.reverse, (v) => this.edit<MediaClip>(id, "reverse", (x) => (x.reverse = v || undefined))) : null,
        m.kind === "video" && trackKind !== "audio" ? this.buttons(["Freeze frame at the playhead", () => this.host.freezeFrame()]) : null,
      ));
    }
    if (m?.audio && !frozen) {
      out.push(this.section("Sound",
        this.keyedSlider(id, "volume", "Volume", { min: 0, max: 2, step: 0.01, format: pct }),
        this.slider("Fade in", { min: 0, max: 5, step: 0.1, get: () => c()?.fadeIn ?? 0, set: (v) => this.edit<MediaClip>(id, "fadeIn", (x) => (x.fadeIn = v)), format: (v) => `${v.toFixed(1)} s` }),
        this.slider("Fade out", { min: 0, max: 5, step: 0.1, get: () => c()?.fadeOut ?? 0, set: (v) => this.edit<MediaClip>(id, "fadeOut", (x) => (x.fadeOut = v)), format: (v) => `${v.toFixed(1)} s` }),
        clip.role !== "voice" ? this.slider("Lower under voice-overs", { min: 0, max: 1, step: 0.05, get: () => c()?.duck ?? 0, set: (v) => this.edit<MediaClip>(id, "duck", (x) => (x.duck = v || undefined)), format: (v) => (v ? `−${Math.round(v * 100)}%` : "Off") }) : null,
        trackKind === "audio" ? this.buttons(
          ["Mark beats", () => this.host.markBeats(id)],
          ...(clip.beats?.length ? [["Clear beats", () => this.edit<MediaClip>(id, "beats", (x) => delete x.beats)] as [string, () => void]] : []),
        ) : null,
        clip.beats?.length ? h("p", { class: "ve-panel-note" }, `${clip.beats.length} beats marked: clips snap to them.`) : null,
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
