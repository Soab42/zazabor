import type { MenuItem } from "../../../../ui/menu";
import type { FeatureFactory, MenuPlace } from "../../extensions";
import { formatTime } from "../../format";
import { isLocation, mediaApi } from "../../media-api";
import { createCast } from "../cast";
import { createConvert } from "../convert";
import { openShortcuts } from "../hotkeys";
import { createIntro } from "../intro";
import type { ProfileHost } from "../profiles/profiles";
import { mediaSettings, onMediaSettings, optionsOf, type MediaSettings } from "../profiles/settings";
import { openProfiles } from "../profiles/ui";
import { closeDialog } from "./dialog";
import { installPlaybackSettings } from "./playback";
import { openCaptureDevice, openFromClipboard, openNetworkStream, openRecent } from "./sources";
import "./media.css";

/** Settings that end up as libVLC instance options. */
const OPTION_KEYS: (keyof MediaSettings)[] = [
  "hardwareDecoding", "networkCaching", "httpReconnect", "deinterlace", "skipLoopFilter", "fastDecode", "replayGain", "threads",
];

/**
 * Opening media beyond files (web streams, cameras, clipboard, recent), Convert, Stream to
 * Device, profiles, the keyboard-shortcuts dialog, the first-run intro, and the player's
 * behaviour settings (resume, default speed, skip interval, on-screen messages, accent).
 */
export const createMediaTools: FeatureFactory = (ctx) => {
  const { shell, player } = ctx;
  const root = ctx.stageLayer.closest<HTMLElement>(".vp");
  const settings = () => mediaSettings(shell);
  const profileHost: ProfileHost = { config: shell.config, save: () => shell.saveConfig(), changed: () => ctx.configChanged() };

  const restorePlayback = installPlaybackSettings(ctx);
  const convert = createConvert(ctx);
  const cast = createCast(ctx);
  const intro = createIntro(ctx, root);

  // ---- look: accent, on-screen messages -------------------------------------------------------
  const osd = root?.querySelector<HTMLElement>(".vp-osd") ?? null;
  const applyLook = () => {
    if (!root) return;
    const s = settings();
    root.dataset.mtAccent = s.playerAccent;
    root.dataset.mtOsd = s.showOsd ? "on" : "off";
    root.dataset.mtKeys = s.showKeys ? "on" : "off";
  };

  // The module hides its message after 900 ms; a different duration is applied from here.
  let tracking = false;
  let shownAt = 0;
  let osdTimer = 0;
  const osdObserver = new MutationObserver((records) => {
    if (!osd) return;
    const wanted = settings().osdSeconds * 1000;
    if (Math.abs(wanted - 900) < 50) {
      tracking = false;
      return;
    }
    const now = performance.now();
    const visible = osd.classList.contains("show");
    if (records.some((r) => r.type === "childList")) shownAt = now;
    if (visible) {
      if (!tracking) {
        tracking = true;
        shownAt = now;
      }
      clearTimeout(osdTimer);
      osdTimer = window.setTimeout(() => {
        tracking = false;
        osd.classList.remove("show");
      }, Math.max(0, wanted - (now - shownAt)));
    } else if (tracking && now - shownAt < wanted - 40) {
      osd.classList.add("show");
    } else {
      tracking = false;
    }
  });
  if (osd) osdObserver.observe(osd, { attributes: true, attributeFilter: ["class"], childList: true });

  // ---- instance options ----------------------------------------------------------------------
  let optionsTimer = 0;
  const pushOptions = () => {
    clearTimeout(optionsTimer);
    optionsTimer = window.setTimeout(() => {
      mediaApi.setOptions(optionsOf(settings())).catch((err) => console.warn("Could not apply video options:", err));
    }, 150);
  };
  const offSettings = onMediaSettings((keys) => {
    applyLook();
    if (keys.some((k) => OPTION_KEYS.includes(k))) pushOptions();
    if (keys.includes("introSeen") && !settings().introSeen) intro.watch();
  });
  applyLook();
  pushOptions();

  // ---- the privacy lock: close what is open and forget the cast device ------------------------
  const lockObserver = new MutationObserver(() => {
    if (!document.body.classList.contains("app-locked")) return;
    closeDialog();
    cast.reset();
  });
  lockObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // ---- actions --------------------------------------------------------------------------------
  const showShortcuts = () => openShortcuts(settings());
  const startConvert = () => {
    const current = player.current;
    convert.open(current && !isLocation(current) ? current : undefined);
  };

  const openItems = (): MenuItem[] => [
    { label: "Network Stream…", icon: "network", action: () => openNetworkStream(ctx) },
    { label: "Capture Device…", icon: "video", action: () => openCaptureDevice(ctx) },
    { label: "From Clipboard…", icon: "paste", action: () => openFromClipboard(ctx) },
    { label: "Recent Media…", icon: "clock", action: () => openRecent(ctx) },
    "separator",
    { label: "Convert…", icon: "refresh", action: startConvert },
    ...(settings().castMenu ? [{ label: cast.active ? "Stream to Device… (casting)" : "Stream to Device…", icon: "desktop", action: () => cast.open() } as MenuItem] : []),
  ];

  return {
    menuItems(place: MenuPlace): MenuItem[] {
      if (place === "open") return openItems();
      if (place === "top") {
        return [
          ...openItems(),
          "separator",
          { label: "Profiles…", icon: "sparkles", action: () => openProfiles(profileHost) },
          { label: "Keyboard Shortcuts…", icon: "terminal", action: showShortcuts },
        ];
      }
      return [
        ...(settings().castMenu ? [{ label: "Stream to Device…", icon: "desktop", action: () => cast.open() } as MenuItem] : []),
        { label: "Keyboard Shortcuts…", icon: "terminal", action: showShortcuts },
      ];
    },

    handleKey(e: KeyboardEvent): boolean {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === "?") {
        showShortcuts();
        return true;
      }
      if (!ctx.showingPlayer || !player.current) return false;
      const s = settings();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // The module's own 5 s / 30 s steps apply unless Settings changed them.
        if (s.skipSeconds === 5 && s.bigSkipSeconds === 30) return false;
        const direction = e.key === "ArrowLeft" ? -1 : 1;
        player.seekBy(direction * (e.shiftKey ? s.bigSkipSeconds : s.skipSeconds) * 1000);
        ctx.showOsd(formatTime(player.state.time), direction < 0 ? "←" : "→");
        return true;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (s.volumeStep === 5) return false;
        const volume = Math.round((player.state.volume + (e.key === "ArrowUp" ? 1 : -1) * (s.volumeStep / 100)) * 100) / 100;
        player.setVolume(volume);
        ctx.showOsd(`${Math.round(Math.min(1.25, Math.max(0, volume)) * 100)}%`, e.key === "ArrowUp" ? "↑" : "↓");
        return true;
      }
      return false;
    },

    dispose() {
      clearTimeout(optionsTimer);
      clearTimeout(osdTimer);
      osdObserver.disconnect();
      lockObserver.disconnect();
      offSettings();
      restorePlayback();
      intro.dispose();
      cast.dispose();
      convert.dispose();
      closeDialog();
      if (root) {
        delete root.dataset.mtAccent;
        delete root.dataset.mtOsd;
        delete root.dataset.mtKeys;
      }
    },
  };
};
