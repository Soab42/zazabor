import { h } from "../../../../ui/dom";
import type { MenuItem } from "../../../../ui/menu";
import { featureSettings, type MenuPlace, type PanelTab, type VideoContext } from "../../extensions";
import { SubtitleController, SUBTITLE_DEFAULTS, type SubtitleSettings } from "./controller";
import { openAddSubtitles } from "./dialog";
import { normalizeStyle } from "./style";
import { createSubtitlesTab } from "./tab";
import { createTimeline } from "./timeline-ui";

export interface SubtitlesFeature {
  controller: SubtitleController;
  tab: PanelTab;
  menuItems(place: MenuPlace): MenuItem[];
  handleKey(e: KeyboardEvent): boolean;
  dispose(): void;
}

/** Settings with every field present, whatever an older or newer version saved. */
function loadSettings(ctx: VideoContext): SubtitleSettings {
  const settings = featureSettings(ctx.shell, "subtitles", {
    ...SUBTITLE_DEFAULTS,
    presets: {},
    assign: {},
    series: {},
    online: { ...SUBTITLE_DEFAULTS.online },
  });
  const object = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  settings.style = normalizeStyle(settings.style);
  settings.presets = object(settings.presets) as SubtitleSettings["presets"];
  settings.assign = object(settings.assign) as SubtitleSettings["assign"];
  settings.series = object(settings.series) as SubtitleSettings["series"];
  settings.online = { ...SUBTITLE_DEFAULTS.online, ...object(settings.online) };
  settings.language = typeof settings.language === "string" ? settings.language : "";
  settings.showTimeline = settings.showTimeline === true;
  return settings;
}

/** Our subtitle renderer, the Subtitles tab, the Add Subtitles dialog and the subtitle keys. */
export function createSubtitles(ctx: VideoContext): SubtitlesFeature {
  const settings = loadSettings(ctx);
  const controller = new SubtitleController(ctx, settings);
  const add = () => openAddSubtitles(controller, ctx);

  // A small timeline over the video when the Playback tab's switch is on.
  const stageTimeline = createTimeline(controller, true);
  const stageBox = h("div", { class: "pp-stage-timeline", hidden: true }, stageTimeline.el);
  ctx.stageLayer.append(stageBox);
  const syncStage = () => {
    const show = settings.showTimeline && controller.engine.active && ctx.showingPlayer;
    if (stageBox.hidden === !show) return;
    stageBox.hidden = !show;
    if (show) stageTimeline.start();
    else stageTimeline.stop();
  };
  const unsubscribe = controller.subscribe(syncStage);
  syncStage();

  return {
    controller,
    tab: createSubtitlesTab(controller, add),
    menuItems(place) {
      return place === "open" ? [] : [{ label: "Add Subtitles…", icon: "subtitles", action: add }];
    },
    handleKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || !ctx.player.current || !ctx.showingPlayer) return false;
      const key = e.key.toLowerCase();
      if (key !== "g" && key !== "h") return false;
      controller.setDelay(controller.delay + (key === "h" ? 50 : -50));
      const ms = controller.delay;
      ctx.showOsd(`Subtitle delay ${ms > 0 ? "+" : ms < 0 ? "−" : ""}${(Math.abs(ms) / 1000).toFixed(2)} s`, key.toUpperCase());
      return true;
    },
    dispose() {
      unsubscribe();
      stageTimeline.dispose();
      stageBox.remove();
      controller.dispose();
    },
  };
}
