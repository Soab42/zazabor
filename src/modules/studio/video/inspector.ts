import type { Aspect } from "../app";
import { h } from "../../../ui/dom";
import type { IconName } from "../../../ui/icons";
import type { MenuItem } from "../../../ui/menu";
import { LOOKS, TRANSITION_GROUPS, transitionLabel, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import {
  area, buttons, callout, colorRow, getPrefs, head, mini, note, openSection, pairRow, row, scrub, scrubRow, section, seg, segRow, select, selectRow,
  showWhen, sliderRow, switchRow, tabs, toggle, toHex, well, type Defaulted, type Keyed, type Syncs,
} from "./controls";
import {
  CURVE_PRESETS, baseValue, curveMean, defaultFrame, defaultFx, defaultMask, defaultPlace, findClip, hasKeys, keyAt, keyTimes, layoutMain, maxDuration,
  maxTransition, mediaOf, MIN_CLIP, projectDuration, propAt, removeKey, setKey, setProp, sourceSpan, touchesPrevious, trimEnd,
  type Clip, type CurvePreset, type Ease, type EffectId, type Keyframe, type KeyProp, type LayerTransitions, type Mask, type Media, type MediaClip,
  type Project, type TextAnim, type TextClip, type Track,
} from "./model";
import type { NumberSpec } from "./scrub";
import { LAYER_TRANSITION_GROUPS } from "./overlays";
import { TEXT_ANIMS, TEXT_FONTS } from "./text";
import { STICKERS, stickerOf } from "./stickers";

/**
 * The right panel, the inspector: the selected clip's properties in tabs by what it is (a video:
 * Video, Adjust, Speed, Audio; a text: Text, Animation; a template: Content, Look), in sections
 * that fold and remember it; the project's when nothing is selected, and what several selected
 * clips share. Rebuilt when the selection (or the kind of thing selected, or the tab) changes;
 * otherwise only its values update (also as the playhead moves, for keyframed values), so typing
 * and dragging keep their focus. Its controls are controls.ts's; see docs/plans/video-editor-ui.md §7.
 */

export interface InspectorHost {
  project(): Project;
  /** The selected clips' ids. */
  selection(): string[];
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
  /** Deletes the selected clips. */
  deleteSelection(): void;
  /** Types a text's words in a box on the preview. */
  editText(id: string): void;
  /** Opens the left panel on transitions (at a layer's slot) or on filters. */
  browse(what: "transitions" | "filters", slot?: "cut" | "in" | "out"): void;
  /** A template clip's views (motion/fields.ts). */
  template?: TemplateViews;
}

export interface TemplateViews {
  info(id: string): { name: string; description: string } | null;
  /** The Content tab's sections (its texts, choices and pictures). */
  content(id: string, syncs: Syncs): Node[];
  /** The Look tab's sections (Brand Kit, colours, fonts, style). */
  look(id: string, syncs: Syncs): Node[];
  menu(id: string): MenuItem[];
}

interface TabView {
  id: string;
  label: string;
  /** The sections it holds, by name (for `reveal`). */
  sections: string[];
  build(): Node[];
}

interface Plan {
  kind: string;
  /** Changes when the inspector has to be built again. */
  key: string;
  /** Where the scroll position is kept (per clip and tab). */
  scroll: string;
  head(): HTMLElement;
  notes?(): Node[];
  tabs: TabView[];
}

const ASPECTS: [Aspect, string][] = [["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"], ["4:5", "4:5"]];
const EASES: [Ease, string][] = [["smooth", "Smooth"], ["linear", "Linear"], ["in", "Ease in"], ["out", "Ease out"], ["hold", "Hold"]];
export const EFFECTS: [EffectId, string][] = [
  ["none", "None"], ["shake", "Shake"], ["pulse", "Zoom pulse"], ["glitch", "Glitch"], ["rgb", "RGB split"], ["vhs", "VHS"],
  ["mirror", "Mirror"], ["flash", "Flash in"], ["blurin", "Blur in"],
];
/** Picture-in-picture spots: name, centre and scale, and where its dot sits in the picker. */
const PIP_SPOTS: [string, number, number, string][] = [
  ["Top left", 0.27, 0.2, "tl"], ["Top right", 0.73, 0.2, "tr"], ["Centre", 0.5, 0.5, "c"], ["Bottom left", 0.27, 0.8, "bl"], ["Bottom right", 0.73, 0.8, "br"],
];
const TRACK_LABEL: Record<Track["kind"], string> = { main: "Main track", overlay: "Overlay", text: "Text track", audio: "Audio track" };
const PLACE_PROPS: KeyProp[] = ["x", "y", "scale", "rotation", "opacity"];

const pct: NumberSpec = { min: 0, max: 1, step: 0.01, scale: 100, decimals: 0, unit: "%" };
const bipolarPct: NumberSpec = { min: -1, max: 1, step: 0.01, scale: 100, decimals: 0, signed: true };
const position: NumberSpec = { min: -0.5, max: 1.5, step: 0.01, scale: 100, offset: 0.5, decimals: 0, unit: "%" };
const seconds = (min: number, max: number): NumberSpec => ({ min, max, step: 0.1, decimals: 1, unit: "s" });
const secs = (t: number) => `${t.toFixed(1)} s`;
const EPS = 1e-6;

export class Inspector {
  readonly el: HTMLElement;
  private top = h("div", { class: "vi-top" });
  private body = h("div", { class: "vi-body" });
  private shown = "";
  private syncs: Syncs = [];
  private lastTimeSync = 0;
  /** The selected clip is off the main track and starts where the clip before it ends. */
  private touching = false;
  private plan: Plan | null = null;
  private tab = "";
  private scrolls = new Map<string, number>();
  /** A mask's last shape and place, to come back to when it's turned on again. */
  private lastMask = new Map<string, Mask>();

  constructor(private host: InspectorHost) {
    this.el = h("aside", { class: "ve-inspector", "aria-label": "Inspector" }, this.top, this.body);
    this.body.addEventListener("scroll", () => this.top.classList.toggle("scrolled", this.body.scrollTop > 2), { passive: true });
    // Alt+K: a keyframe for the property whose row has the keyboard.
    this.el.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== "k") return;
      const key = (document.activeElement as HTMLElement | null)?.closest(".vc-row")?.querySelector<HTMLButtonElement>(".vc-key");
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      key.click();
    });
    this.refresh(true);
  }

  /** Rebuilds when the selection (or the kind of thing selected) changed, else updates values. */
  refresh(force = false) {
    const plan = this.makePlan();
    if (!force && plan.key === this.shown) {
      for (const s of this.syncs) s();
      return;
    }
    if (this.plan) this.scrolls.set(this.plan.scroll, this.body.scrollTop);
    this.shown = plan.key;
    this.plan = plan;
    this.syncs = [];
    const tabBar = plan.tabs.length > 1
      ? tabs({ label: "Inspector tabs", items: plan.tabs.map((t) => [t.id, t.label] as const), get: () => this.tab, set: (id) => this.showTab(id, true) })
      : null;
    this.top.replaceChildren(plan.head(), ...(plan.notes?.() ?? []), ...(tabBar ? [h("div", { class: "vi-tabs" }, tabBar)] : []));
    const view = plan.tabs.find((t) => t.id === this.tab) ?? plan.tabs[0];
    this.body.replaceChildren(...(view?.build() ?? []));
    // Readouts filled by their syncs show from the start.
    for (const s of this.syncs) s();
    this.body.scrollTop = this.scrolls.get(plan.scroll) ?? 0;
    this.top.classList.toggle("scrolled", this.body.scrollTop > 2);
  }

  private showTab(id: string, focus = false) {
    if (!this.plan) return;
    getPrefs().setTab(this.plan.kind, id);
    this.refresh(true);
    if (focus) this.top.querySelector<HTMLButtonElement>(".vc-tabs button.active")?.focus();
  }

  /** Shows a section (by name: "speed", "content"), opening its tab and the section, and puts the keyboard in its first field. */
  reveal(name: string, field = "input, textarea, select") {
    const tab = this.plan?.tabs.find((t) => t.sections.includes(name));
    if (tab && tab.id !== this.tab) this.showTab(tab.id);
    const el = this.body.querySelector<HTMLElement>(`[data-section$=":${name}"]`);
    if (!el) return;
    openSection(el);
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(field);
    input?.focus({ preventScroll: true });
    if (input instanceof HTMLTextAreaElement || (input instanceof HTMLInputElement && input.type === "text" && !input.readOnly)) input.select();
  }

  /** The playhead moved: keyframed values and the diamonds follow (at most ten times a second). */
  timeChanged(playing: boolean) {
    const now = performance.now();
    if (playing && now - this.lastTimeSync < 100) return;
    this.lastTimeSync = now;
    for (const s of this.syncs) s();
  }

  // ---- what to show

  private makePlan(): Plan {
    const p = this.host.project();
    const ids = this.host.selection().filter((id) => findClip(p, id));
    if (ids.length > 1) return this.multiPlan(ids);
    const found = ids.length ? findClip(p, ids[0]) : null;
    if (!found) return this.projectPlan();
    const { clip, track, index } = found;
    // Off the main track, the transition rows shown follow what's set and whether it touches the clip before.
    this.touching = track.kind !== "main" && touchesPrevious(track, index);
    const layer = `${!!clip.transIn}:${!!clip.transOut}:${!!clip.transition}:${this.touching}`;
    if (clip.type === "media") return this.mediaPlan(clip, track, index, layer);
    if (clip.type === "template") return this.templatePlan(clip.id, track, layer);
    return clip.sticker ? this.stickerPlan(clip, track, layer) : this.textPlan(clip, track, layer);
  }

  /** Picks the remembered tab for `kind` (or the first), and the build key. */
  private finish(kind: string, base: string, scrollId: string, tabList: TabView[], headFn: () => HTMLElement, notes?: () => Node[]): Plan {
    const remembered = getPrefs().tab(kind);
    this.tab = tabList.some((t) => t.id === remembered) ? remembered! : tabList[0]?.id ?? "";
    return { kind, key: `${base}|${this.tab}`, scroll: `${scrollId}:${this.tab}`, head: headFn, notes, tabs: tabList };
  }

  private sid(kind: string, name: string) {
    return `${kind}:${name}`;
  }

  // ---- helpers

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

  /** The keyframes of a clip's `props` at the playhead. */
  private keysHere(c: Clip | null, props?: KeyProp[]): Keyframe[] {
    if (!c?.keys) return [];
    const local = this.local(c);
    return Object.entries(c.keys).filter(([p]) => !props || props.includes(p as KeyProp))
      .flatMap(([, list]) => list ?? []).filter((k) => Math.abs(k.t - local) <= 1 / 60);
  }

  private navKey(id: string, dir: -1 | 1, props?: KeyProp[]) {
    const clip = this.live(id);
    if (!clip) return;
    const local = this.local(clip);
    const times = props
      ? [...new Set(props.flatMap((p) => clip.keys?.[p]?.map((k) => k.t) ?? []))].sort((a, b) => a - b)
      : keyTimes(clip);
    const next = dir > 0 ? times.find((t) => t > local + 1e-3) : [...times].reverse().find((t) => t < local - 1e-3);
    if (next !== undefined) this.host.seek(clip.start + next);
  }

  private keyed(id: string, props: KeyProp[]): Keyed {
    const c = () => this.live(id);
    return {
      has: () => {
        const x = c();
        return !!x && props.some((p) => hasKeys(x, p));
      },
      on: () => {
        const x = c();
        return !!x && props.some((p) => !!keyAt(x, p, this.local(x)));
      },
      toggle: () => this.edit(id, `key-${props.join("-")}`, (x) => {
        const local = this.local(x);
        const on = props.some((p) => keyAt(x, p, local));
        for (const p of props) {
          if (on) removeKey(x, p, local);
          else setKey(x, p, local, propAt(x, p, local));
        }
      }),
      menu: () => {
        const here = this.keysHere(c(), props);
        const items: MenuItem[] = here.length
          ? EASES.map(([ease, label]) => ({
            label: `${here.every((k) => k.ease === ease) ? "✓ " : ""}${label}`,
            action: () => this.edit(id, "ease", (x) => {
              for (const k of this.keysHere(x, props)) k.ease = ease;
            }),
          }))
          : [];
        if (items.length) items.push("separator");
        items.push(
          { label: "Previous Keyframe", icon: "chevronLeft", action: () => this.navKey(id, -1, props) },
          { label: "Next Keyframe", icon: "chevronRight", action: () => this.navKey(id, 1, props) },
          "separator",
          { label: "Remove All Keyframes", icon: "trash", danger: true, disabled: !props.some((p) => !!c() && hasKeys(c()!, p)), action: () => this.edit(id, "keys-clear", (x) => {
            for (const p of props) if (x.keys) delete x.keys[p];
            if (x.keys && !Object.keys(x.keys).length) delete x.keys;
          }) },
        );
        return items;
      },
    };
  }

  /** Reset for keyable properties: their defaults, keyframes and all. */
  private propDefault(id: string, props: KeyProp[], defs: number[]): Defaulted {
    return {
      modified: () => {
        const x = this.live(id);
        return !!x && props.some((p, i) => hasKeys(x, p) || Math.abs(baseValue(x, p) - defs[i]) > EPS);
      },
      reset: () => this.edit(id, `reset-${props.join("-")}`, (x) => {
        props.forEach((p, i) => {
          if (x.keys) delete x.keys[p];
          if (x.keys && !Object.keys(x.keys).length) delete x.keys;
          setProp(x, p, 0, defs[i]);
        });
      }),
    };
  }

  /** Reset for a plain value. */
  private plainDefault(get: () => number | undefined, def: number, reset: () => void): Defaulted {
    return { modified: () => Math.abs((get() ?? def) - def) > EPS, reset };
  }

  /** A keyable property's row: its value at the playhead, edited there. */
  private propRow(id: string, prop: KeyProp, label: string, spec: NumberSpec, def: number, bipolar = false): HTMLElement {
    const c = () => this.live(id);
    return sliderRow(this.syncs, label, {
      ...spec,
      bipolar,
      default: def,
      get: () => {
        const x = c();
        return x ? propAt(x, prop, this.local(x)) : def;
      },
      set: (v) => this.edit(id, prop, (x) => setProp(x, prop, this.local(x), v)),
      animated: () => {
        const x = c();
        return !!x && hasKeys(x, prop);
      },
      keyed: this.keyed(id, [prop]),
      def: this.propDefault(id, [prop], [def]),
    });
  }

  /** A plain number with a slider and a reset. */
  private valueRow(label: string, spec: NumberSpec, get: () => number | undefined, set: (v: number) => void, def: number, bipolar = false): HTMLElement {
    return sliderRow(this.syncs, label, {
      ...spec, bipolar, default: def,
      get: () => get() ?? def,
      set,
      def: this.plainDefault(get, def, () => set(def)),
    });
  }

  private mediaHeadMenu(clip: MediaClip, video: boolean, trackKind: Track["kind"]): () => MenuItem[] {
    return () => {
      const items: MenuItem[] = [{ label: "Reset This Tab", icon: "undo", action: () => this.resetTab(clip.id, trackKind) }];
      if (video && trackKind !== "audio" && clip.freeze === undefined) items.push({ label: "Freeze Frame at Playhead", icon: "snowflake", action: () => this.host.freezeFrame() });
      items.push("separator", { label: "Delete Clip", icon: "trash", shortcut: "Delete", danger: true, action: () => this.host.deleteSelection() });
      return items;
    };
  }

  /** "Reset This Tab": the tab's properties back to their defaults, in one undo step. */
  private resetTab(id: string, trackKind: Track["kind"]) {
    const tab = this.tab;
    this.edit<MediaClip>(id, `reset-tab-${tab}`, (x, q) => {
      const dropKeys = (props: KeyProp[]) => {
        if (x.keys) for (const p of props) delete x.keys[p];
        if (x.keys && !Object.keys(x.keys).length) delete x.keys;
      };
      if (tab === "video" || tab === "image") {
        x.place = { ...defaultPlace(), ...(trackKind === "main" ? {} : { scale: x.place.scale }) };
        dropKeys(PLACE_PROPS);
        x.frame = null;
        x.mask = null;
        x.fx.key = null;
        x.motion = false;
      } else if (tab === "adjust") {
        x.fx = { ...defaultFx(), key: x.fx.key };
      } else if (tab === "speed") {
        const m = mediaOf(q, x.media);
        const span = sourceSpan(x);
        x.speed = 1;
        x.curve = null;
        delete x.reverse;
        if (m) x.duration = Math.max(MIN_CLIP, Math.min(span, maxDuration(x, m)));
        if (trackKind === "main") layoutMain(q);
      } else if (tab === "audio") {
        x.volume = 1;
        dropKeys(["volume"]);
        x.fadeIn = 0;
        x.fadeOut = 0;
        delete x.duck;
      }
    });
  }

  // ---- Transform (every visual clip)

  private transform(kind: string, id: string, o: { media: boolean; main: boolean; overlay: boolean; image: boolean; open?: boolean }): HTMLElement {
    const c = () => this.live(id);
    const posGet = (p: "x" | "y") => () => {
      const x = c();
      return x ? propAt(x, p, this.local(x)) : 0.5;
    };
    const posSet = (p: "x" | "y") => (v: number) => this.edit(id, p, (x) => setProp(x, p, this.local(x), v));
    const animated = (p: KeyProp) => () => {
      const x = c();
      return !!x && hasKeys(x, p);
    };
    const keyed = () => {
      const x = c();
      return !!x && PLACE_PROPS.some((p) => hasKeys(x, p));
    };
    const ease = selectRow(this.syncs, "Ease", EASES, () => this.keysHere(c(), PLACE_PROPS)[0]?.ease ?? "smooth", (v) => this.edit(id, "ease", (x) => {
      for (const k of this.keysHere(x, PLACE_PROPS)) k.ease = v;
    }));
    showWhen(this.syncs, ease, () => this.keysHere(c(), PLACE_PROPS).length > 0);
    ease.title = "How the keyframe at the playhead eases into the next";
    return section(this.syncs, {
      id: this.sid(kind, "transform"), title: "Transform", open: o.open ?? true,
      summary: () => {
        const x = c();
        if (!x) return "";
        return keyed() ? "Animated" : `${Math.round(x.place.scale * 100)}% · ${Math.round(x.place.rotation)}°`;
      },
      modified: () => {
        const x = c();
        if (!x) return false;
        const d = defaultPlace();
        return keyed() || (["x", "y", "rotation", "opacity"] as const).some((p) => Math.abs(x.place[p] - d[p]) > EPS) || (o.main && Math.abs(x.place.scale - 1) > EPS);
      },
      reset: () => this.edit(id, "reset", (x) => {
        x.place = { ...defaultPlace(), ...(o.main ? {} : { scale: x.place.scale }) };
        if (x.keys) for (const prop of PLACE_PROPS) delete x.keys[prop];
        if (x.keys && !Object.keys(x.keys).length) delete x.keys;
      }),
      keys: { any: keyed, prev: () => this.navKey(id, -1, PLACE_PROPS), next: () => this.navKey(id, 1, PLACE_PROPS) },
    },
    o.media ? segRow(this.syncs, "Fit", [["fill", "Fill"], ["fit", "Fit"]] as const, () => this.live<MediaClip>(id)?.fit ?? "fill", (v) => this.edit<MediaClip>(id, "fit", (x) => (x.fit = v))) : null,
    o.image ? switchRow(this.syncs, "Ken Burns", () => this.live<MediaClip>(id)?.motion ?? false, (v) => this.edit<MediaClip>(id, "motion", (x) => (x.motion = v))) : null,
    pairRow(this.syncs, "Position",
      { ...position, label: "X position", prefix: "X", get: posGet("x"), set: posSet("x"), animated: animated("x") },
      { ...position, label: "Y position", prefix: "Y", get: posGet("y"), set: posSet("y"), animated: animated("y") },
      this.keyed(id, ["x", "y"]), this.propDefault(id, ["x", "y"], [0.5, 0.5])),
    this.propRow(id, "scale", "Scale", { min: 0.1, max: 3, step: 0.01, scale: 100, decimals: 0, unit: "%" }, 1),
    this.propRow(id, "rotation", "Rotation", { min: -180, max: 180, step: 1, decimals: 0, unit: "°" }, 0, true),
    this.propRow(id, "opacity", "Opacity", pct, 1),
    o.overlay && o.media ? this.snapRow(id) : null,
    ease,
    );
  }

  /** Picture in picture: the clip to a corner or the middle, fitted and framed. */
  private snapRow(id: string): HTMLElement {
    const picker = h("div", { class: "vc-spots", role: "group", "aria-label": "Snap to" }, ...PIP_SPOTS.map(([label, x, y, cls]) =>
      h("button", { class: `vc-spot ${cls}`, type: "button", title: label, "aria-label": label, onclick: () => this.edit<MediaClip>(id, "pip", (k) => {
        const scale = cls === "c" ? 0.6 : 0.4;
        setProp(k, "x", this.local(k), x);
        setProp(k, "y", this.local(k), y);
        setProp(k, "scale", this.local(k), scale);
        k.fit = "fit";
        k.frame ??= defaultFrame();
      }) })));
    return row("Snap to", picker, { title: "Picture in picture: a corner or the middle, with a frame" });
  }

  // ---- Transitions (a main-track cut, or a layer's in, out and the cut before it)

  private transitions(kind: string, id: string, track: Track["kind"], index: number): HTMLElement | null {
    const c = () => this.live(id);
    if (track === "main") {
      if (index === 0) return null;
      const kinds = TRANSITION_GROUPS.flatMap((g) => g.items.map(([k, l]) => [k, l] as [TransitionKind, string]));
      const options: [TransitionKind | "none", string][] = [["none", "None"], ...kinds];
      const kindSelect = select(this.syncs, "Transition", options, () => c()?.transition?.kind ?? "none", (v) => this.edit<MediaClip>(id, "transition", (x, q) => {
        if (v === "none") delete x.transition;
        else x.transition = { kind: v, duration: x.transition?.duration ?? 0.6 };
        layoutMain(q);
      }));
      const length = this.lengthField("Transition length", () => c()?.transition?.duration, (v) => this.edit<MediaClip>(id, "transition-length", (x, q) => {
        if (!x.transition) return;
        const i = q.tracks[0].clips.findIndex((k) => k.id === x.id);
        x.transition.duration = Math.min(v, maxTransition(q.tracks[0], i));
      }), 0.6);
      return section(this.syncs, {
        id: this.sid(kind, "transitions"), title: "Transition in",
        open: () => !!c()?.transition,
        summary: () => {
          const t = c()?.transition;
          return t ? `${transitionLabel(t.kind)} · ${secs(t.duration)}` : "None";
        },
        modified: () => !!c()?.transition,
        reset: () => this.edit<MediaClip>(id, "transition", (x, q) => {
          delete x.transition;
          layoutMain(q);
        }),
        menu: () => [{ label: "Browse Transitions…", icon: "sparkles", shortcut: "Alt+7", action: () => this.host.browse("transitions", "cut") }],
        tip: "Plays across the cut from the clip before",
      }, row("Kind", kindSelect, { value: length }));
    }
    if (track === "audio") return null;
    const kinds: [TransitionKind | "none", string][] = [["none", "None"], ...LAYER_TRANSITION_GROUPS.flatMap((g) => g.items)];
    const slotOf: Record<keyof LayerTransitions, "in" | "out" | "cut"> = { transIn: "in", transOut: "out", transition: "cut" };
    const slotRow = (label: string, key: keyof LayerTransitions, tip?: string) => row(label,
      select(this.syncs, label, kinds, () => c()?.[key]?.kind ?? "none", (v) => this.edit(id, key, (x) => {
        if (v === "none") delete x[key];
        else x[key] = { kind: v, duration: x[key]?.duration ?? 0.5 };
      })),
      {
        value: this.lengthField(`${label} length`, () => c()?.[key]?.duration, (v) => this.edit(id, `${key}-length`, (x) => {
          const tr = x[key];
          if (tr) tr.duration = v;
        }), 0.5),
        acts: h("span", { class: "vc-acts" }, h("span", { class: "vc-slot" }),
          mini("sparkles", `Browse ${label.toLowerCase()} transitions`, () => this.host.browse("transitions", slotOf[key]))),
        title: tip,
      });
    const any = () => !!(c()?.transIn || c()?.transOut || c()?.transition);
    return section(this.syncs, {
      id: this.sid(kind, "transitions"), title: "Transitions", open: any,
      summary: () => {
        const x = c();
        const parts = [x?.transIn ? `In: ${transitionLabel(x.transIn.kind)}` : "", x?.transOut ? `Out: ${transitionLabel(x.transOut.kind)}` : "", x?.transition ? `Between: ${transitionLabel(x.transition.kind)}` : ""].filter(Boolean);
        return parts.join(" · ") || "None";
      },
      modified: any,
      reset: () => this.edit(id, "transitions-clear", (x) => {
        delete x.transIn;
        delete x.transOut;
        delete x.transition;
      }),
      tip: "How it comes on and goes off",
    },
    slotRow("In", "transIn"),
    slotRow("Out", "transOut"),
    this.touching ? slotRow("Between", "transition", "This clip starts where the one before it ends: a transition between them plays across the cut, instead of that clip's out and this one's in.") : null,
    );
  }

  /** A transition's length in a row's value column ("—" while there's none). */
  private lengthField(label: string, get: () => number | undefined, set: (v: number) => void, def: number): HTMLElement {
    return scrubRowField(this.syncs, label, get, set, def);
  }

  // ---- media

  private mediaPlan(clip: MediaClip, track: Track, index: number, layer: string): Plan {
    const p = this.host.project();
    const id = clip.id;
    const m = mediaOf(p, clip.media);
    const frozen = clip.freeze !== undefined;
    const visual = !!m && m.kind !== "audio" && track.kind !== "audio";
    const shape = `${frozen}:${!!clip.fx.key}:${!!clip.mask}:${!!clip.frame}:${!!clip.fx.lut}:${clip.fx.effect !== "none"}:${!!clip.curve}:${m?.missing ?? ""}:${!!m?.note}`;
    const base = `${id}:${track.kind}:${shape}:${layer}`;
    if (!m) {
      return this.finish("missing", base, id, [{ id: "clip", label: "Clip", sections: [], build: () => [] }],
        () => head({ icon: "video", title: "Missing file", menu: () => [{ label: "Delete Clip", icon: "trash", danger: true, action: () => this.host.deleteSelection() }] }),
        () => [callout("This clip's file isn't in the project any more.", "danger")]);
    }
    const image = m.kind === "image" || frozen;
    const kind = !visual ? "audio" : image ? "image" : "video";
    const video = m.kind === "video";
    const iconName: IconName = m.kind === "audio" ? (clip.role === "voice" ? "veMic" : "music") : frozen ? "snowflake" : m.kind === "image" ? "image" : "video";
    const title = frozen ? "Freeze frame" : clip.role === "voice" ? "Voice-over" : m.name;
    const meta = [secs(clip.duration), visual && m.width ? `${m.width}×${m.height}` : "", TRACK_LABEL[track.kind]].filter(Boolean).join(" · ");
    const list: TabView[] = [];
    if (visual) {
      list.push({
        id: image ? "image" : "video", label: image ? "Image" : "Video", sections: ["transform", "timing", "frame", "mask", "chroma", "transitions"],
        build: () => this.pictureTab(kind, clip, m, track.kind, index, image),
      });
      list.push({ id: "adjust", label: "Adjust", sections: ["filter", "basic", "effect", "detail", "lut"], build: () => this.adjustTab(kind, clip) });
    }
    if (!image) list.push({ id: "speed", label: "Speed", sections: ["speed"], build: () => [this.speedSection(kind, clip, m, track.kind)] });
    if (m.audio && !frozen) {
      const audio: TabView = { id: "audio", label: "Audio", sections: ["volume", "fades", "ducking", "beats"], build: () => this.audioTab(kind, clip, track.kind) };
      // On an audio track, sound is what the clip is: its tab comes first.
      if (visual) list.push(audio);
      else list.unshift(audio);
    }
    const notes = () => [
      m.missing ? callout(`${m.path} can't be found.`, "danger") : null,
      m.note && !m.missing ? callout(m.note, "warn") : null,
    ].filter((n): n is HTMLElement => !!n);
    return this.finish(kind, base, id, list,
      () => head({ icon: iconName, title, meta, tip: m.path, menu: this.mediaHeadMenu(clip, video, track.kind) }), notes);
  }

  private pictureTab(kind: string, clip: MediaClip, m: Media, trackKind: Track["kind"], index: number, image: boolean): Node[] {
    const id = clip.id;
    const c = () => this.live<MediaClip>(id);
    const out: (Node | null)[] = [this.transform(kind, id, { media: true, main: trackKind === "main", overlay: trackKind === "overlay", image: m.kind === "image" })];
    if (image) {
      out.push(section(this.syncs, { id: this.sid(kind, "timing"), title: "Timing", summary: () => secs(c()?.duration ?? 3) },
        scrubRow(this.syncs, "Duration", {
          ...seconds(0.5, 30),
          get: () => c()?.duration ?? 3,
          set: (v) => this.edit<MediaClip>(id, "duration", (x, q) => trimEnd(q, x.id, x.start + v)),
        })));
    }
    // Frame: rounded corners, a border and a shadow.
    const frame = () => c()?.frame ?? null;
    out.push(section(this.syncs, {
      id: this.sid(kind, "frame"), title: "Frame",
      enable: { get: () => !!frame(), set: (v) => this.edit<MediaClip>(id, "frame", (x) => (x.frame = v ? defaultFrame() : null)) },
      summary: () => `Rounded · ${Math.round((frame()?.radius ?? 0) * 100)}%`,
      modified: () => {
        const f = frame(), d = defaultFrame();
        return !!f && (Math.abs(f.radius - d.radius) > EPS || Math.abs(f.border - d.border) > EPS || f.color !== d.color || Math.abs(f.shadow - d.shadow) > EPS);
      },
      reset: () => this.edit<MediaClip>(id, "frame", (x) => (x.frame = defaultFrame())),
      tip: "Rounded corners, a border and a shadow",
    }, ...(clip.frame ? [
      this.valueRow("Corners", { ...pct, max: 0.5, step: 0.005 }, () => frame()?.radius, (v) => this.edit<MediaClip>(id, "frame-r", (x) => x.frame && (x.frame.radius = v)), 0.08),
      row("Border", well(this.syncs, "Border colour", { get: () => frame()?.color ?? "#ffffff", set: (v) => this.edit<MediaClip>(id, "frame-c", (x) => x.frame && (x.frame.color = v ?? "#ffffff")), fallback: "#ffffff" }), {
        value: scrubRowField(this.syncs, "Border width", () => frame()?.border, (v) => this.edit<MediaClip>(id, "frame-b", (x) => x.frame && (x.frame.border = v)), 6,
          { min: 0, max: 30, step: 0.5, decimals: 1, unit: "px" }),
      }),
      this.valueRow("Shadow", pct, () => frame()?.shadow, (v) => this.edit<MediaClip>(id, "frame-s", (x) => x.frame && (x.frame.shadow = v)), 0.5),
    ] : [])));
    // Mask: a circle or a rectangle, feathered, maybe inverted.
    const mask = () => c()?.mask ?? null;
    const mset = (k: "x" | "y" | "w" | "h" | "feather", v: number) => this.edit<MediaClip>(id, `mask-${k}`, (x) => x.mask && (x.mask[k] = v));
    const maskNum = (label: string, prefix: string, k: "x" | "y" | "w" | "h", spec: NumberSpec, def: number) =>
      ({ ...spec, label, prefix, get: () => mask()?.[k] ?? def, set: (v: number) => mset(k, v) });
    out.push(section(this.syncs, {
      id: this.sid(kind, "mask"), title: "Mask",
      enable: {
        get: () => !!mask(),
        set: (v) => this.edit<MediaClip>(id, "mask", (x) => {
          if (!v && x.mask) this.lastMask.set(id, { ...x.mask });
          x.mask = v ? { ...(this.lastMask.get(id) ?? defaultMask()) } : null;
        }),
      },
      summary: () => (mask()?.shape === "rect" ? "Rectangle" : "Circle") + (mask()?.invert ? " · inverted" : ""),
      modified: () => {
        const k = mask(), d = defaultMask();
        return !!k && (k.shape !== d.shape || (["x", "y", "w", "h", "feather"] as const).some((p) => Math.abs(k[p] - d[p]) > EPS) || k.invert);
      },
      reset: () => this.edit<MediaClip>(id, "mask", (x) => (x.mask = defaultMask())),
      tip: "Shows the clip through a shape",
    }, ...(clip.mask ? [
      segRow(this.syncs, "Shape", [["circle", "Circle", "pfOval"], ["rect", "Rectangle", "pfRect"]] as const, () => mask()?.shape ?? "circle",
        (v) => this.edit<MediaClip>(id, "mask", (x) => (x.mask = { ...(x.mask ?? defaultMask()), shape: v }))),
      pairRow(this.syncs, "Centre", maskNum("Mask centre X", "X", "x", { ...position, min: 0, max: 1 }, 0.5), maskNum("Mask centre Y", "Y", "y", { ...position, min: 0, max: 1 }, 0.5)),
      pairRow(this.syncs, "Size", maskNum("Mask width", "W", "w", { ...pct, min: 0.02, max: 3 }, 0.6), maskNum("Mask height", "H", "h", { ...pct, min: 0.02, max: 3 }, 0.6)),
      this.valueRow("Feather", { ...pct, max: 0.3, step: 0.005, decimals: 1 }, () => mask()?.feather, (v) => mset("feather", v), 0.04),
      switchRow(this.syncs, "Invert", () => mask()?.invert ?? false, (v) => this.edit<MediaClip>(id, "mask-invert", (x) => x.mask && (x.mask.invert = v))),
    ] : [])));
    // Chroma key: one colour taken out.
    const key = () => c()?.fx.key ?? null;
    out.push(section(this.syncs, {
      id: this.sid(kind, "chroma"), title: "Chroma key",
      enable: { get: () => !!key(), set: (v) => this.edit<MediaClip>(id, "key", (x) => (x.fx.key = v ? { color: "#00b140", tolerance: 0.35, softness: 0.25, spill: 0.4 } : null)) },
      summary: () => toHex(key()?.color ?? "#00b140").toUpperCase(),
      modified: () => {
        const k = key();
        return !!k && (Math.abs(k.tolerance - 0.35) > EPS || Math.abs(k.softness - 0.25) > EPS || Math.abs(k.spill - 0.4) > EPS || toHex(k.color) !== "#00b140");
      },
      reset: () => this.edit<MediaClip>(id, "key", (x) => (x.fx.key = { color: "#00b140", tolerance: 0.35, softness: 0.25, spill: 0.4 })),
      tip: "Takes a colour out (a green screen)",
    }, ...(clip.fx.key ? [
      colorRow(this.syncs, "Key colour", {
        get: () => key()?.color ?? "#00b140", set: (v) => this.edit<MediaClip>(id, "key-color", (x) => x.fx.key && (x.fx.key.color = v ?? "#00b140")),
        fallback: "#00b140", eyedropper: () => this.host.pickKeyColor(id),
      }),
      this.valueRow("Strength", pct, () => key()?.tolerance, (v) => this.edit<MediaClip>(id, "key-tol", (x) => x.fx.key && (x.fx.key.tolerance = v)), 0.35),
      this.valueRow("Edge", pct, () => key()?.softness, (v) => this.edit<MediaClip>(id, "key-soft", (x) => x.fx.key && (x.fx.key.softness = v)), 0.25),
      this.valueRow("Spill", pct, () => key()?.spill, (v) => this.edit<MediaClip>(id, "key-spill", (x) => x.fx.key && (x.fx.key.spill = v)), 0.4),
    ] : [])));
    out.push(this.transitions(kind, id, trackKind, index));
    return out.filter((n): n is Node => !!n);
  }

  private adjustTab(kind: string, clip: MediaClip): Node[] {
    const id = clip.id;
    const c = () => this.live<MediaClip>(id);
    const fx = () => c()?.fx ?? defaultFx();
    const looks: [LookId | "none", string][] = [["none", "None"], ...LOOKS.map((l) => [l.id, l.label] as [LookId, string])];
    const lookLabel = () => looks.find(([v]) => v === fx().look)?.[1] ?? "None";
    const effectLabel = () => EFFECTS.find(([v]) => v === fx().effect)?.[1] ?? "None";
    const lutName = h("span", { class: "vc-file-name" });
    this.syncs.push(() => {
      lutName.textContent = fx().lut?.name ?? "None";
      lutName.title = fx().lut?.name ?? "";
    });
    const detail = ["blur", "sharpen", "vignette", "grain"] as const;
    return [
      section(this.syncs, {
        id: this.sid(kind, "filter"), title: "Filter", summary: lookLabel,
        modified: () => fx().look !== "none",
        reset: () => this.edit<MediaClip>(id, "look", (x) => (x.fx.look = "none")),
      }, row("Look", select(this.syncs, "Filter", looks, () => fx().look, (v) => this.edit<MediaClip>(id, "look", (x) => (x.fx.look = v))), {
        acts: h("span", { class: "vc-acts" }, h("span", { class: "vc-slot" }), mini("palette", "Browse filters (Alt+6)", () => this.host.browse("filters"))),
      })),
      section(this.syncs, {
        id: this.sid(kind, "basic"), title: "Basic",
        summary: () => (["brightness", "contrast", "saturation"] as const).some((k) => Math.abs(fx()[k]) > EPS) ? "Adjusted" : "",
        modified: () => (["brightness", "contrast", "saturation"] as const).some((k) => Math.abs(fx()[k]) > EPS),
        reset: () => this.edit<MediaClip>(id, "basic-reset", (x) => {
          x.fx.brightness = 0;
          x.fx.contrast = 0;
          x.fx.saturation = 0;
        }),
      },
      this.valueRow("Brightness", bipolarPct, () => fx().brightness, (v) => this.edit<MediaClip>(id, "brightness", (x) => (x.fx.brightness = v)), 0, true),
      this.valueRow("Contrast", bipolarPct, () => fx().contrast, (v) => this.edit<MediaClip>(id, "contrast", (x) => (x.fx.contrast = v)), 0, true),
      this.valueRow("Saturation", bipolarPct, () => fx().saturation, (v) => this.edit<MediaClip>(id, "saturation", (x) => (x.fx.saturation = v)), 0, true),
      ),
      section(this.syncs, {
        id: this.sid(kind, "effect"), title: "Effect", open: () => fx().effect !== "none", summary: effectLabel,
        modified: () => fx().effect !== "none",
        reset: () => this.edit<MediaClip>(id, "effect", (x) => {
          x.fx.effect = "none";
          x.fx.amount = 0.6;
        }),
      },
      selectRow(this.syncs, "Effect", EFFECTS, () => fx().effect, (v) => this.edit<MediaClip>(id, "effect", (x) => (x.fx.effect = v)), {
        acts: h("span", { class: "vc-acts" }, h("span", { class: "vc-slot" }), mini("sparkles", "Browse effects (Alt+6)", () => this.host.browse("filters"))),
      }),
      clip.fx.effect !== "none" ? this.valueRow("Amount", pct, () => fx().amount, (v) => this.edit<MediaClip>(id, "amount", (x) => (x.fx.amount = v)), 0.6) : null,
      ),
      section(this.syncs, {
        id: this.sid(kind, "detail"), title: "Detail", open: () => detail.some((k) => fx()[k] > EPS),
        summary: () => (detail.some((k) => fx()[k] > EPS) ? "Adjusted" : ""),
        modified: () => detail.some((k) => fx()[k] > EPS),
        reset: () => this.edit<MediaClip>(id, "detail-reset", (x) => {
          for (const k of detail) x.fx[k] = 0;
        }),
      }, ...detail.map((k) => this.valueRow(k[0].toUpperCase() + k.slice(1), pct, () => fx()[k], (v) => this.edit<MediaClip>(id, k, (x) => (x.fx[k] = v)), 0))),
      section(this.syncs, {
        id: this.sid(kind, "lut"), title: "Colour table", open: () => !!fx().lut,
        summary: () => fx().lut?.name ?? "None",
        modified: () => !!fx().lut,
        reset: () => this.edit<MediaClip>(id, "lut", (x) => (x.fx.lut = null)),
        tip: "A .cube LUT",
      },
      row("File", [lutName, h("button", { class: "btn small", type: "button", title: "Load a .cube colour table", onclick: () => this.host.loadLut(id) }, clip.fx.lut ? "Change…" : "Load…")]),
      clip.fx.lut ? this.valueRow("Strength", pct, () => fx().lut?.strength, (v) => this.edit<MediaClip>(id, "lut-strength", (x) => x.fx.lut && (x.fx.lut.strength = v)), 1) : null,
      ),
    ];
  }

  private speedSection(kind: string, clip: MediaClip, m: Media, trackKind: Track["kind"]): HTMLElement {
    const id = clip.id;
    const c = () => this.live<MediaClip>(id);
    const video = m.kind === "video";
    const curves: [CurvePreset, string][] = Object.entries(CURVE_PRESETS).map(([k, v]) => [k as CurvePreset, v.label]);
    const setSpeed = (x: MediaClip, q: Project, v: number) => {
      // The same part of the file plays, faster or slower.
      const span = sourceSpan(x);
      x.speed = v;
      x.duration = Math.max(MIN_CLIP, Math.min(span / (v * (x.curve ? curveMean(x) : 1)), maxDuration(x, m)));
      if (trackKind === "main") layoutMain(q);
    };
    const setCurve = (v: CurvePreset | null) => this.edit<MediaClip>(id, "curve", (x, q) => {
      // The clip keeps playing the same part of its file; its length follows the curve.
      const span = sourceSpan(x);
      x.curve = v ? { preset: v, points: [...CURVE_PRESETS[v].points] } : null;
      x.duration = Math.max(MIN_CLIP, span / (x.speed * curveMean(x)));
      if (trackKind === "main") layoutMain(q);
    });
    const length = h("span", { class: "vc-readout" });
    this.syncs.push(() => (length.textContent = secs(c()?.duration ?? clip.duration)));
    const presets = [0.5, 1, 1.5, 2].map((s) => [String(s), `${s}×`] as const);
    return section(this.syncs, {
      id: this.sid(kind, "speed"), title: "Speed",
      summary: () => (c()?.curve ? CURVE_PRESETS[c()!.curve!.preset].label : `${(c()?.speed ?? 1).toFixed(2)}×`) + (c()?.reverse ? " · reversed" : ""),
      modified: () => Math.abs((c()?.speed ?? 1) - 1) > EPS || !!c()?.curve || !!c()?.reverse,
      reset: () => this.edit<MediaClip>(id, "speed-reset", (x, q) => {
        x.curve = null;
        delete x.reverse;
        setSpeed(x, q, 1);
      }),
      menu: video && trackKind !== "audio" ? () => [{ label: "Freeze Frame at Playhead", icon: "snowflake", action: () => this.host.freezeFrame() }] : undefined,
    },
    video ? segRow(this.syncs, "Mode", [["standard", "Standard"], ["curve", "Curve"]] as const, () => (c()?.curve ? "curve" : "standard"),
      (v) => setCurve(v === "curve" ? curves[0][0] : null)) : null,
    ...(!clip.curve ? [
      sliderRow(this.syncs, "Speed", {
        min: 0.25, max: 4, step: 0.05, decimals: 2, unit: "×", default: 1,
        get: () => c()?.speed ?? 1,
        set: (v) => this.edit<MediaClip>(id, "speed", (x, q) => setSpeed(x, q, v)),
        def: this.plainDefault(() => c()?.speed, 1, () => this.edit<MediaClip>(id, "speed", (x, q) => setSpeed(x, q, 1))),
      }),
      row(null, seg(this.syncs, "Speed presets", presets, () => {
        const s = c()?.speed ?? 1;
        return presets.find(([v]) => Math.abs(Number(v) - s) < EPS)?.[0] ?? null;
      }, (v) => this.edit<MediaClip>(id, "speed-preset", (x, q) => setSpeed(x, q, Number(v))), "vc-presets")),
    ] : [
      selectRow(this.syncs, "Curve", curves, () => c()?.curve?.preset ?? curves[0][0], (v) => setCurve(v)),
    ]),
    video ? switchRow(this.syncs, "Reverse", () => !!c()?.reverse, (v) => this.edit<MediaClip>(id, "reverse", (x) => (x.reverse = v || undefined))) : null,
    row("Length", length, { title: "How long the clip plays at this speed" }),
    );
  }

  private audioTab(kind: string, clip: MediaClip, trackKind: Track["kind"]): Node[] {
    const id = clip.id;
    const c = () => this.live<MediaClip>(id);
    const fades = () => (c()?.fadeIn ?? 0) > EPS || (c()?.fadeOut ?? 0) > EPS;
    return [
      section(this.syncs, {
        id: this.sid(kind, "volume"), title: "Volume",
        summary: () => `${Math.round((c()?.volume ?? 1) * 100)}%${c() && hasKeys(c()!, "volume") ? " · animated" : ""}`,
        keys: { any: () => !!c() && hasKeys(c()!, "volume"), prev: () => this.navKey(id, -1, ["volume"]), next: () => this.navKey(id, 1, ["volume"]) },
      }, this.propRow(id, "volume", "Volume", { ...pct, max: 2 }, 1)),
      section(this.syncs, {
        id: this.sid(kind, "fades"), title: "Fades",
        summary: () => (fades() ? `${secs(c()?.fadeIn ?? 0)} in · ${secs(c()?.fadeOut ?? 0)} out` : "None"),
        modified: fades,
        reset: () => this.edit<MediaClip>(id, "fades-reset", (x) => {
          x.fadeIn = 0;
          x.fadeOut = 0;
        }),
      },
      scrubRow(this.syncs, "Fade in", { ...seconds(0, 5), get: () => c()?.fadeIn ?? 0, set: (v) => this.edit<MediaClip>(id, "fadeIn", (x) => (x.fadeIn = v)),
        def: this.plainDefault(() => c()?.fadeIn, 0, () => this.edit<MediaClip>(id, "fadeIn", (x) => (x.fadeIn = 0))) }),
      scrubRow(this.syncs, "Fade out", { ...seconds(0, 5), get: () => c()?.fadeOut ?? 0, set: (v) => this.edit<MediaClip>(id, "fadeOut", (x) => (x.fadeOut = v)),
        def: this.plainDefault(() => c()?.fadeOut, 0, () => this.edit<MediaClip>(id, "fadeOut", (x) => (x.fadeOut = 0))) }),
      ),
      clip.role !== "voice" ? section(this.syncs, {
        id: this.sid(kind, "ducking"), title: "Ducking", open: () => (c()?.duck ?? 0) > 0,
        summary: () => ((c()?.duck ?? 0) > 0 ? `−${Math.round((c()?.duck ?? 0) * 100)}%` : "Off"),
        tip: "Lowers this clip while a voice-over plays",
      }, this.valueRow("Duck by", { ...pct, step: 0.05, format: (v) => (v > EPS ? `−${Math.round(v * 100)} %` : "Off") }, () => c()?.duck,
        (v) => this.edit<MediaClip>(id, "duck", (x) => (x.duck = v || undefined)), 0)) : null,
      trackKind === "audio" ? section(this.syncs, {
        id: this.sid(kind, "beats"), title: "Beats",
        summary: () => (c()?.beats?.length ? `${c()!.beats!.length} marked` : "None"),
        tip: "Marks on the music that clips snap to",
      },
      buttons(["Mark beats", () => this.host.markBeats(id)], clip.beats?.length ? ["Clear", () => this.edit<MediaClip>(id, "beats", (x) => delete x.beats)] : null),
      clip.beats?.length ? note(`${clip.beats.length} beats marked: clips snap to them.`) : null,
      ) : null,
    ].filter((n): n is HTMLElement => !!n);
  }

  // ---- texts and stickers

  private textPlan(clip: TextClip, track: Track, layer: string): Plan {
    const id = clip.id;
    const kind = "text";
    const base = `${id}:${track.kind}:${!!clip.words?.length}:${layer}`;
    const list: TabView[] = [
      { id: "text", label: "Text", sections: ["content", "style", "transform"], build: () => this.textTab(clip) },
      { id: "animation", label: "Animation", sections: ["inout", "transitions", "timing"], build: () => this.animationTab(kind, clip, track, false) },
    ];
    const name = clip.text.split("\n")[0].trim() || "Text";
    return this.finish(kind, base, id, list, () => head({
      icon: "textBox", title: name.length > 40 ? `${name.slice(0, 40)}…` : name, meta: `${secs(clip.duration)} · ${TRACK_LABEL[track.kind]}`,
      menu: () => [
        { label: "Edit Text on the Preview", icon: "pencil", action: () => this.host.editText(id) },
        "separator",
        { label: "Delete", icon: "trash", shortcut: "Delete", danger: true, action: () => this.host.deleteSelection() },
      ],
    }));
  }

  private textTab(clip: TextClip): Node[] {
    const kind = "text";
    const id = clip.id;
    const c = () => this.live<TextClip>(id);
    const style = <K extends keyof TextClip["style"]>(k: K, v: TextClip["style"][K]) => this.edit<TextClip>(id, `style-${String(k)}`, (x) => (x.style[k] = v));
    const fonts = TEXT_FONTS.map(([v, l]) => [v, l] as [string, string]);
    if (!fonts.some(([v]) => v === clip.style.font)) fonts.push([clip.style.font, clip.style.font]);
    const text = area(this.syncs, {
      label: "Text", get: () => c()?.text ?? "", set: (v) => this.edit<TextClip>(id, "text", (x) => (x.text = v)),
      placeholder: "Type here, or double-click the text on the preview", max: 6, cls: "ve-textarea",
    });
    return [
      section(this.syncs, { id: this.sid(kind, "content"), title: "Content", summary: () => (c()?.text ?? "").split("\n")[0] }, h("div", { class: "vc-block" }, text)),
      section(this.syncs, { id: this.sid(kind, "style"), title: "Style", summary: () => fonts.find(([v]) => v === c()?.style.font)?.[1] ?? "" },
        selectRow(this.syncs, "Font", fonts, () => c()?.style.font ?? "sans-serif", (v) => style("font", v)),
        this.valueRow("Size", { min: 12, max: 200, step: 1, decimals: 0 }, () => c()?.style.size, (v) => style("size", v), 56),
        row("Style", [
          toggle(this.syncs, "Bold", "B", () => !!c()?.style.bold, (v) => this.edit<TextClip>(id, "style-bold", (x) => (x.style.bold = v)), "bold"),
          toggle(this.syncs, "Italic", "I", () => !!c()?.style.italic, (v) => this.edit<TextClip>(id, "style-italic", (x) => (x.style.italic = v)), "italic"),
          h("span", { class: "spacer" }),
          seg(this.syncs, "Align", [["left", "Align left", "alignLeft"], ["center", "Centre", "alignCenter"], ["right", "Align right", "alignRight"]] as const,
            () => c()?.style.align ?? "center", (v) => style("align", v), "vc-icons"),
        ]),
        colorRow(this.syncs, "Fill", { get: () => c()?.style.color ?? "#ffffff", set: (v) => style("color", v ?? "#ffffff"), fallback: "#ffffff" }),
        colorRow(this.syncs, "Outline", {
          get: () => c()?.style.stroke ?? null, optional: true, fallback: "#000000",
          set: (v) => this.edit<TextClip>(id, "style-stroke", (x) => {
            x.style.stroke = v;
            if (v && !x.style.strokeWidth) x.style.strokeWidth = 90;
          }),
        }),
        colorRow(this.syncs, "Background", { get: () => c()?.style.box ?? null, optional: true, fallback: "#000000", set: (v) => style("box", v ? withAlpha(v, 0.7) : null) }),
        switchRow(this.syncs, "Shadow", () => c()?.style.shadow ?? false, (v) => style("shadow", v)),
        clip.words?.length
          ? colorRow(this.syncs, "Spoken word", { get: () => c()?.highlight ?? null, optional: true, fallback: "#ffd23f", set: (v) => this.edit<TextClip>(id, "highlight", (x) => (x.highlight = v)) })
          : null,
      ),
      this.transform(kind, id, { media: false, main: false, overlay: false, image: false }),
    ];
  }

  /** In and out animations, the layer's transitions, and how long it shows. */
  private animationTab(kind: string, clip: TextClip, track: Track, sticker: boolean): Node[] {
    const id = clip.id;
    const c = () => this.live<TextClip>(id);
    const anims = sticker ? TEXT_ANIMS.filter(([a]) => a !== "typewriter") : TEXT_ANIMS;
    const outs = TEXT_ANIMS.filter(([a]) => a !== "typewriter");
    const label = (a: TextAnim | undefined) => TEXT_ANIMS.find(([v]) => v === a)?.[1] ?? "None";
    const index = track.clips.findIndex((x) => x.id === id);
    return [
      section(this.syncs, {
        id: this.sid(kind, "inout"), title: "In and out",
        summary: () => `${label(c()?.animIn)} · ${label(c()?.animOut)}`,
      },
      selectRow(this.syncs, "In", anims, () => c()?.animIn ?? "none", (v: TextAnim) => this.edit<TextClip>(id, "animIn", (x) => (x.animIn = v))),
      selectRow(this.syncs, "Out", outs, () => c()?.animOut ?? "none", (v: TextAnim) => this.edit<TextClip>(id, "animOut", (x) => (x.animOut = v))),
      ),
      this.transitions(kind, id, track.kind, index),
      section(this.syncs, { id: this.sid(kind, "timing"), title: "Timing", summary: () => secs(c()?.duration ?? 3) },
        scrubRow(this.syncs, "Duration", {
          ...seconds(sticker ? 0.3 : 0.5, 30),
          get: () => c()?.duration ?? 3,
          set: (v) => this.edit<TextClip>(id, "duration", (x, q) => trimEnd(q, x.id, x.start + v)),
        })),
    ].filter((n): n is HTMLElement => !!n);
  }

  private stickerPlan(clip: TextClip, track: Track, layer: string): Plan {
    const id = clip.id;
    const kind = "sticker";
    const c = () => this.live<TextClip>(id);
    const base = `${id}:${track.kind}:${clip.sticker}:${layer}`;
    const style = <K extends keyof TextClip["style"]>(k: K, v: TextClip["style"][K]) => this.edit<TextClip>(id, `style-${String(k)}`, (x) => (x.style[k] = v));
    const options = STICKERS.map((s) => [s.id, s.label] as [string, string]);
    const list: TabView[] = [
      {
        id: "sticker", label: "Sticker", sections: ["sticker", "transform"],
        build: () => [
          section(this.syncs, { id: this.sid(kind, "sticker"), title: "Sticker", summary: () => stickerOf(c()?.sticker)?.label ?? "" },
            selectRow(this.syncs, "Sticker", options, () => c()?.sticker ?? "arrow", (v) => this.edit<TextClip>(id, "sticker", (x) => {
              x.sticker = v;
              x.text = stickerOf(v)?.label ?? x.text;
            })),
            stickerOf(clip.sticker)?.tint === false ? null : colorRow(this.syncs, "Colour", { get: () => c()?.style.color ?? "#ffcc00", set: (v) => style("color", v ?? "#ffcc00"), fallback: "#ffcc00" }),
            this.valueRow("Size", { min: 40, max: 900, step: 5, scale: 0.1, decimals: 0, unit: "%" }, () => c()?.style.size, (v) => style("size", v), 240),
          ),
          this.transform(kind, id, { media: false, main: false, overlay: false, image: false }),
        ],
      },
      { id: "animation", label: "Animation", sections: ["inout", "transitions", "timing"], build: () => this.animationTab(kind, clip, track, true) },
    ];
    return this.finish(kind, base, id, list, () => head({
      icon: "veSticker", title: stickerOf(clip.sticker)?.label ?? "Sticker", meta: `Sticker · ${secs(clip.duration)}`,
      menu: () => [{ label: "Delete", icon: "trash", shortcut: "Delete", danger: true, action: () => this.host.deleteSelection() }],
    }));
  }

  // ---- templates

  private templatePlan(id: string, track: Track, layer: string): Plan {
    const t = this.host.template;
    const clip = this.live(id);
    const shape = clip?.type === "template" ? `${clip.name}:${clip.kit}:${!!clip.ungrouped}` : "";
    const kind = "template";
    const index = track.clips.findIndex((x) => x.id === id);
    const list: TabView[] = [
      {
        id: "content", label: "Content", sections: ["content", "transform", "transitions"],
        build: () => [
          ...(t?.content(id, this.syncs) ?? []),
          this.transform(kind, id, { media: false, main: false, overlay: false, image: false, open: false }),
          this.transitions(kind, id, track.kind, index),
        ].filter((n): n is Node => !!n),
      },
      { id: "look", label: "Look", sections: ["kit", "colours", "fonts", "style"], build: () => t?.look(id, this.syncs) ?? [] },
    ];
    const info = t?.info(id);
    return this.finish(kind, `${id}:${track.kind}:${shape}:${layer}`, id, list, () => head({
      icon: "template", title: info?.name ?? "Template", meta: `Template · ${secs(clip?.duration ?? 0)} · ${TRACK_LABEL[track.kind]}`, tip: info?.description,
      menu: () => [...(t?.menu(id) ?? []), "separator", { label: "Delete", icon: "trash", shortcut: "Delete", danger: true, action: () => this.host.deleteSelection() }],
    }));
  }

  // ---- nothing selected: the project

  private projectPlan(): Plan {
    const p = this.host.project();
    const kind = "project";
    const bg = () => this.host.project().canvas.background;
    const list: TabView[] = [{
      id: "project", label: "Project", sections: ["canvas", "info"],
      build: () => {
        const length = h("span", { class: "vc-readout" });
        const files = h("span", { class: "vc-readout" });
        this.syncs.push(() => {
          const q = this.host.project();
          length.textContent = secs(projectDuration(q));
          files.textContent = String(q.media.length);
        });
        const presets = h("span", { class: "vc-presets-dots" },
          ...([["#000000", "Black"], ["#ffffff", "White"]] as const).map(([v, label]) => h("button", {
            type: "button", class: "vc-swatch", title: label, "aria-label": label, style: { background: v },
            onclick: () => this.host.change((q) => (q.canvas.background = v), "background"),
          })));
        const colour = row("Colour", [well(this.syncs, "Background colour", { get: () => (bg() === "blur" ? "#000000" : bg()), set: (v) => this.host.change((q) => (q.canvas.background = v ?? "#000000"), "background"), fallback: "#000000" }), presets]);
        showWhen(this.syncs, colour, () => bg() !== "blur");
        return [
          section(this.syncs, { id: this.sid(kind, "canvas"), title: "Canvas", summary: () => `${this.host.project().canvas.aspect} · ${this.host.project().canvas.fps} fps` },
            segRow(this.syncs, "Shape", ASPECTS, () => this.host.project().canvas.aspect, (v) => this.host.setAspect(v)),
            segRow(this.syncs, "Background", [["blur", "Blur"], ["colour", "Colour"]] as const, () => (bg() === "blur" ? "blur" : "colour"), (v) =>
              this.host.change((q) => (q.canvas.background = v === "blur" ? "blur" : q.canvas.background === "blur" ? "#000000" : q.canvas.background), "background")),
            colour,
            selectRow(this.syncs, "Frame rate", [["24", "24 fps"], ["25", "25 fps"], ["30", "30 fps"], ["50", "50 fps"], ["60", "60 fps"]] as const, () => String(this.host.project().canvas.fps) as "30", (v) =>
              this.host.change((q) => (q.canvas.fps = Number(v)), "fps")),
          ),
          section(this.syncs, { id: this.sid(kind, "info"), title: "Project" },
            row("Length", length),
            row("Files", files),
            note("Select a clip on the timeline to edit it.", "vc-hint"),
          ),
        ];
      },
    }];
    return this.finish(kind, `project:${p.canvas.aspect}:${p.media.length}`, "project", list,
      () => head({ icon: "videoEdit", title: "Project", meta: `${p.canvas.aspect} · ${p.canvas.fps} fps · ${secs(projectDuration(p))}` }));
  }

  // ---- several selected: what they share

  private multiPlan(ids: string[]): Plan {
    const p = this.host.project();
    const clips = () => ids.map((id) => findClip(this.host.project(), id)?.clip).filter((c): c is Clip => !!c);
    const now = clips();
    const counts = new Map<string, number>();
    for (const c of now) {
      const what = c.type === "media" ? mediaOf(p, c.media)?.kind ?? "clip" : c.type === "template" ? "template" : c.sticker ? "sticker" : "text";
      counts.set(what, (counts.get(what) ?? 0) + 1);
    }
    const meta = [...counts].map(([k, n]) => `${n} ${k}${n === 1 ? "" : k === "audio" ? "" : "s"}`).join(" · ");
    const kind = "multi";
    const visual = () => clips().filter((c): c is MediaClip => c.type === "media" && mediaOf(this.host.project(), c.media)?.kind !== "audio");
    const sounding = () => clips().filter((c): c is MediaClip => c.type === "media" && !!mediaOf(this.host.project(), c.media)?.audio);
    const allSound = now.length > 0 && now.every((c) => c.type === "media" && !!mediaOf(p, c.media)?.audio);
    const anyVisual = now.some((c) => c.type === "media" && mediaOf(p, c.media)?.kind !== "audio");
    const common = (get: (c: Clip) => number, list: () => Clip[]) => ({
      get: () => {
        const l = list();
        return l.length ? get(l[0]) : 0;
      },
      mixed: () => {
        const l = list();
        return l.some((c) => Math.abs(get(c) - get(l[0])) > EPS);
      },
    });
    const setAll = (key: string, list: () => Clip[], fn: (c: Clip) => void) => {
      const want = new Set(list().map((c) => c.id));
      this.host.change((q) => {
        for (const t of q.tracks) for (const c of t.clips) if (want.has(c.id)) fn(c);
      }, `multi:${key}`);
    };
    const looks: [string, string][] = [["mixed", "—"], ["none", "None"], ...LOOKS.map((l) => [l.id, l.label] as [string, string])];
    const list: TabView[] = [{
      id: "selection", label: "Selection", sections: ["common"],
      build: () => {
        const opacity = common((c) => propAt(c, "opacity", this.local(c)), clips);
        const volume = common((c) => propAt(c, "volume", this.local(c)), sounding);
        return [section(this.syncs, { id: this.sid(kind, "common"), title: "Shared" },
          sliderRow(this.syncs, "Opacity", { ...pct, ...opacity, set: (v) => setAll("opacity", clips, (c) => setProp(c, "opacity", this.local(c), v)) }),
          allSound ? sliderRow(this.syncs, "Volume", { ...pct, max: 2, ...volume, set: (v) => setAll("volume", sounding, (c) => setProp(c, "volume", this.local(c), v)) }) : null,
          anyVisual ? selectRow(this.syncs, "Filter", looks, () => {
            const v = visual();
            return v.length && v.every((c) => c.fx.look === v[0].fx.look) ? v[0].fx.look : "mixed";
          }, (v) => {
            if (v !== "mixed") setAll("look", visual, (c) => c.type === "media" && (c.fx.look = v as LookId | "none"));
          }) : null,
          note("Edits here change every selected clip.", "vc-hint"),
        )];
      },
    }];
    return this.finish(kind, `multi:${ids.join(",")}:${allSound}:${anyVisual}`, "multi", list, () => head({
      icon: "checkSquare", title: `${ids.length} clips selected`, meta,
      menu: () => [{ label: "Delete Clips", icon: "trash", shortcut: "Delete", danger: true, action: () => this.host.deleteSelection() }],
    }));
  }
}

/** A length in a row's value column: "—" and disabled while there's nothing to measure. */
function scrubRowField(syncs: Syncs, label: string, get: () => number | undefined, set: (v: number) => void, def: number, spec: NumberSpec = { min: 0.2, max: 2, step: 0.1, decimals: 1, unit: "s" }): HTMLElement {
  return scrub(syncs, { ...spec, label, get: () => get() ?? def, set, mixed: () => get() === undefined, disabled: () => get() === undefined });
}

function withAlpha(hex: string, alpha: number): string {
  const v = parseInt(toHex(hex).slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

