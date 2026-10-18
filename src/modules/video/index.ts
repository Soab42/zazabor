import type { AppModule, ModuleFactory } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";

/** Placeholder until the VLC-based player lands (see docs/PLAN.md, section 8). */
class VideoModule implements AppModule {
  readonly id = "video" as const;
  readonly title = "Video";
  readonly icon: IconName = "video";
  readonly el = h(
    "div",
    { class: "sh-empty-host" },
    h(
      "div",
      { class: "sh-empty" },
      h("div", { class: "sh-empty-icon" }, icon("video", 38)),
      h("h2", null, "Video player is on its way"),
      h("p", null, "CorePro will play almost any video with the VLC engine, wrapped in a calm, redesigned player with subtitles, audio tracks and resume."),
    ),
  );

  activate() {}
  deactivate() {}
  handleKey() {
    return false;
  }
}

/** Creates the Video module. */
export const createVideoModule: ModuleFactory = () => new VideoModule();
