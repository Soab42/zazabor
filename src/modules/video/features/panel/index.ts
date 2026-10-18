import "./panel.css";
import { featureSettings, type FeatureFactory, type VideoContext, type VideoFeature } from "../../extensions";
import { createSubtitles } from "../subtitles";
import { createAudioTab, PANEL_DEFAULTS, type PanelSettings } from "./audio";
import { createPlaybackTab } from "./playback";
import { createVideoTab } from "./video";

/** Settings with every field present (older or newer versions may have saved less or more). */
function loadSettings(ctx: VideoContext): PanelSettings {
  const settings = featureSettings(ctx.shell, "panel", { ...PANEL_DEFAULTS, eq: { ...PANEL_DEFAULTS.eq, bands: [...PANEL_DEFAULTS.eq.bands] } });
  const eq = { ...PANEL_DEFAULTS.eq, ...(settings.eq && typeof settings.eq === "object" ? settings.eq : {}) };
  eq.bands = Array.from({ length: 10 }, (_, i) => (Number.isFinite(eq.bands?.[i]) ? Number(eq.bands[i]) : 0));
  eq.preamp = Number.isFinite(eq.preamp) ? eq.preamp : 0;
  eq.enabled = eq.enabled === true;
  settings.eq = eq;
  settings.audioLanguage = typeof settings.audioLanguage === "string" ? settings.audioLanguage : "";
  return settings;
}

/**
 * The side panel's Subtitles, Audio, Video and Playback tabs (orders 10 to 40), our subtitle
 * renderer and the Add Subtitles menu items. One feature so the tabs can share state.
 */
const createPanelFeature: FeatureFactory = (ctx): VideoFeature => {
  const settings = loadSettings(ctx);
  const subtitles = createSubtitles(ctx);
  const audio = createAudioTab(ctx, settings);
  const video = createVideoTab(ctx);
  const playback = createPlaybackTab(ctx, {
    get: () => subtitles.controller.settings.showTimeline,
    set: (on) => {
      subtitles.controller.settings.showTimeline = on;
      subtitles.controller.save();
      subtitles.controller.emitSettings();
    },
  });

  return {
    panelTabs: [subtitles.tab, audio.tab, video.tab, playback.tab],
    handleKey: (e) => subtitles.handleKey(e),
    dispose() {
      subtitles.dispose();
      audio.dispose();
      video.dispose();
      playback.dispose();
    },
  };
};

export const panelFeatures: FeatureFactory[] = [createPanelFeature];
