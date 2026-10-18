import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { PanelTab, VideoContext } from "../../extensions";
import { panelApi, type VideoTracks } from "../../panel-api";
import { DEFAULT_FX, fxOf, type SurfaceFx, type VideoFx } from "../../surface";
import { choiceRow, note, section, slider, toggle } from "./ui";

/** Preview tiles: each shows the current frame through some effects; clicking one applies them. */
const LOOKS: { name: string; fx: Partial<VideoFx> }[] = [
  { name: "Original", fx: {} },
  { name: "Brighter", fx: { brightness: 0.12 } },
  { name: "Contrast", fx: { contrast: 1.3 } },
  { name: "Vivid", fx: { saturation: 1.5, contrast: 1.08 } },
  { name: "Muted", fx: { saturation: 0.55 } },
  { name: "Hue shift", fx: { hue: 40 } },
  { name: "Lift shadows", fx: { gamma: 1.5 } },
  { name: "Sharper", fx: { sharpen: 1 } },
  { name: "Black & white", fx: { grayscale: 1 } },
  { name: "Sepia", fx: { sepia: 1 } },
  { name: "Invert", fx: { invert: 1 } },
  { name: "Vignette", fx: { vignette: 0.8 } },
];

/** The colour fields a look sets; a look starts from these defaults, geometry is left alone. */
const COLOR_KEYS = ["brightness", "contrast", "saturation", "hue", "gamma", "sharpen", "grayscale", "sepia", "invert", "vignette"] as const;
const colorDefaults = (): Partial<VideoFx> => Object.fromEntries(COLOR_KEYS.map((k) => [k, DEFAULT_FX[k]]));

const ASPECTS: { label: string; value: number | null }[] = [
  { label: "Auto", value: null },
  { label: "16:9", value: 16 / 9 },
  { label: "4:3", value: 4 / 3 },
  { label: "21:9", value: 21 / 9 },
  { label: "1:1", value: 1 },
];

/** How often the preview tiles are redrawn while the tab is open. */
const PREVIEW_MS = 500;

const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.001);

/** The Video tab: tracks, filters with live previews, flip / rotate / zoom / aspect, HDR. */
export function createVideoTab(ctx: VideoContext): { tab: PanelTab; dispose(): void } {
  const fx: SurfaceFx | undefined = fxOf(ctx.surface);
  let tracks: VideoTracks = { tracks: [], current: -1 };
  let visible = false;
  let path: string | null = null;
  let timer = 0;
  let lastFrame = -1;
  let lastKey = "";

  // ---- tracks ------------------------------------------------------------------------------
  const tracksBox = h("div", { class: "pp-choices", role: "radiogroup", "aria-label": "Video track" });
  function renderTracks() {
    tracksBox.replaceChildren(...(tracks.tracks.length
      ? tracks.tracks.map((t, i) => choiceRow(t.name, tracks.current === t.id || (tracks.current < 0 && i === 0), () => {
        void panelApi.setVideoTrack(t.id).then(loadTracks).catch(() => undefined);
      }))
      : [note("No video track yet.")]));
  }
  async function loadTracks() {
    try {
      tracks = await panelApi.videoTracks();
    } catch {
      tracks = { tracks: [], current: -1 };
    }
    renderTracks();
  }

  // ---- looks (preview tiles) ---------------------------------------------------------------
  const tileCanvases = LOOKS.map((look) => {
    const canvas = h("canvas", { class: "pp-tile-canvas", width: 160, height: 90, "aria-hidden": "true" });
    return { look, canvas };
  });
  const tiles = h("div", { class: "pp-tiles", role: "group", "aria-label": "Filters" },
    ...tileCanvases.map(({ look, canvas }) =>
      h("button", { type: "button", class: "pp-tile", "data-look": look.name, title: look.name, onclick: () => fx?.set({ ...colorDefaults(), ...look.fx }) },
        canvas, h("span", { class: "pp-tile-name" }, look.name))));

  function drawPreviews(force = false) {
    if (!fx || !visible || !fx.hasFrame) return;
    if (!force && fx.frameCounter === lastFrame) return;
    lastFrame = fx.frameCounter;
    fx.renderPreviews(tileCanvases.map(({ look, canvas }) => ({ canvas, fx: look.fx })));
  }

  function markLook(current: VideoFx) {
    for (const el of tiles.querySelectorAll<HTMLElement>(".pp-tile")) {
      const look = LOOKS.find((l) => l.name === el.dataset.look)!;
      const target = { ...DEFAULT_FX, ...look.fx };
      el.classList.toggle("selected", COLOR_KEYS.every((k) => Math.abs((current[k] as number) - (target[k] as number)) < 0.001));
    }
  }

  // ---- adjustments -------------------------------------------------------------------------
  const sliders = {
    brightness: slider({ label: "Brightness", min: -100, max: 100, step: 1, value: 0, format: (v) => `${v > 0 ? "+" : ""}${v}`, onInput: (v) => fx?.set({ brightness: v / 100 }), resetTo: 0 }),
    contrast: slider({ label: "Contrast", min: 50, max: 200, step: 1, value: 100, format: (v) => `${v}%`, onInput: (v) => fx?.set({ contrast: v / 100 }), resetTo: 100 }),
    saturation: slider({ label: "Saturation", min: 0, max: 200, step: 1, value: 100, format: (v) => `${v}%`, onInput: (v) => fx?.set({ saturation: v / 100 }), resetTo: 100 }),
    hue: slider({ label: "Hue", min: -180, max: 180, step: 1, value: 0, format: (v) => `${v}°`, onInput: (v) => fx?.set({ hue: v }), resetTo: 0 }),
    gamma: slider({ label: "Gamma", min: 50, max: 250, step: 5, value: 100, format: (v) => (v / 100).toFixed(2), onInput: (v) => fx?.set({ gamma: v / 100 }), resetTo: 100 }),
    sharpen: slider({ label: "Sharpen", min: 0, max: 200, step: 5, value: 0, format: (v) => `${v}%`, onInput: (v) => fx?.set({ sharpen: v / 100 }), resetTo: 0 }),
    grayscale: slider({ label: "Black & white", min: 0, max: 100, step: 1, value: 0, format: (v) => `${v}%`, onInput: (v) => fx?.set({ grayscale: v / 100 }), resetTo: 0 }),
    sepia: slider({ label: "Sepia", min: 0, max: 100, step: 1, value: 0, format: (v) => `${v}%`, onInput: (v) => fx?.set({ sepia: v / 100 }), resetTo: 0 }),
    invert: slider({ label: "Invert", min: 0, max: 100, step: 1, value: 0, format: (v) => `${v}%`, onInput: (v) => fx?.set({ invert: v / 100 }), resetTo: 0 }),
    vignette: slider({ label: "Vignette", min: 0, max: 100, step: 1, value: 0, format: (v) => `${v}%`, onInput: (v) => fx?.set({ vignette: v / 100 }), resetTo: 0 }),
  };
  const adjust = h("details", { class: "pp-advanced" }, h("summary", null, "Fine-tune"), ...Object.values(sliders).map((s) => s.el));

  // ---- picture geometry ----------------------------------------------------------------------
  const flipH = h("button", { class: "btn small", type: "button", onclick: () => fx && fx.set({ flipH: !fx.get().flipH }) }, "Flip horizontally");
  const flipV = h("button", { class: "btn small", type: "button", onclick: () => fx && fx.set({ flipV: !fx.get().flipV }) }, "Flip vertically");
  const turn = (by: number) => fx && fx.set({ rotate: ((((fx.get().rotate + by) % 360) + 360) % 360) as VideoFx["rotate"] });
  const rotation = h("span", { class: "pp-value" }, "0°");
  const rotate = h("div", { class: "pp-rotate" },
    h("span", { class: "pp-label" }, "Rotate"), rotation,
    h("button", { class: "btn small", type: "button", title: "Rotate left", onclick: () => turn(-90) }, "↺ 90°"),
    h("button", { class: "btn small", type: "button", title: "Rotate right", onclick: () => turn(90) }, "↻ 90°"));
  const zoom = slider({ label: "Zoom", min: 100, max: 400, step: 5, value: 100, format: (v) => `${v}%`, onInput: (v) => fx?.set({ zoom: v / 100 }), resetTo: 100 });
  const panX = slider({ label: "Move left / right", min: -100, max: 100, step: 1, value: 0, format: (v) => String(v), onInput: (v) => fx?.set({ panX: v / 100 }), resetTo: 0 });
  const panY = slider({ label: "Move up / down", min: -100, max: 100, step: 1, value: 0, format: (v) => String(v), onInput: (v) => fx?.set({ panY: v / 100 }), resetTo: 0 });
  const aspectButtons = ASPECTS.map((a) => h("button", { type: "button", onclick: () => fx?.set({ aspect: a.value }) }, a.label));
  const aspect = h("div", { class: "segmented pp-segmented", role: "group", "aria-label": "Aspect ratio" }, ...aspectButtons);
  const hdr = toggle("HDR tone mapping", false, (on) => fx?.set({ hdr: on }), "Brings back contrast in washed-out HDR videos");
  const reset = h("button", { class: "btn small ghost", type: "button", onclick: () => fx?.reset() }, icon("refresh", 13), "Reset all");

  function sync(v: VideoFx) {
    sliders.brightness.set(Math.round(v.brightness * 100));
    sliders.contrast.set(Math.round(v.contrast * 100));
    sliders.saturation.set(Math.round(v.saturation * 100));
    sliders.hue.set(Math.round(v.hue));
    sliders.gamma.set(Math.round(v.gamma * 100));
    sliders.sharpen.set(Math.round(v.sharpen * 100));
    sliders.grayscale.set(Math.round(v.grayscale * 100));
    sliders.sepia.set(Math.round(v.sepia * 100));
    sliders.invert.set(Math.round(v.invert * 100));
    sliders.vignette.set(Math.round(v.vignette * 100));
    zoom.set(Math.round(v.zoom * 100));
    panX.set(Math.round(v.panX * 100));
    panY.set(Math.round(v.panY * 100));
    flipH.classList.toggle("active", v.flipH);
    flipV.classList.toggle("active", v.flipV);
    rotation.textContent = `${v.rotate}°`;
    ASPECTS.forEach((a, i) => aspectButtons[i].classList.toggle("active", same(a.value, v.aspect)));
    hdr.set(v.hdr);
    markLook(v);
    const key = JSON.stringify(v);
    if (key !== lastKey) {
      lastKey = key;
      drawPreviews(true);
    }
  }

  const unsubscribeFx = fx?.subscribe(sync);
  const unsubscribePlayer = ctx.player.subscribe(() => {
    if (ctx.player.state.path !== path) {
      path = ctx.player.state.path;
      tracks = { tracks: [], current: -1 };
      if (visible) renderTracks();
      lastFrame = -1;
      // Nothing of a locked or closed video stays in the tiles.
      if (!path) for (const { canvas } of tileCanvases) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
    // Tracks appear a moment after the file starts.
    if (visible && ctx.player.state.playing && tracks.tracks.length === 0) void loadTracks();
  });

  return {
    tab: {
      id: "video",
      title: "Video",
      icon: "film",
      order: 30,
      render() {
        if (fx) sync(fx.get());
        renderTracks();
        return h("div", { class: "pp" },
          fx ? null : note("Picture effects are not available."),
          section("Video track", tracksBox),
          section("Filters", tiles, adjust),
          section("Picture",
            h("div", { class: "pp-dialog-buttons" }, flipH, flipV), rotate,
            h("div", { class: "pp-row-split" }, h("span", { class: "pp-label" }, "Aspect ratio"), aspect),
            zoom.el, panX.el, panY.el, hdr.el,
            h("div", { class: "pp-dialog-buttons" }, reset),
            note("Effects are drawn by the player and last until you reset them or quit.")));
      },
      shown() {
        visible = true;
        void loadTracks();
        lastFrame = -1;
        drawPreviews(true);
        timer = window.setInterval(() => drawPreviews(), PREVIEW_MS);
      },
      hidden() {
        visible = false;
        clearInterval(timer);
      },
    },
    dispose() {
      clearInterval(timer);
      unsubscribeFx?.();
      unsubscribePlayer();
    },
  };
}
