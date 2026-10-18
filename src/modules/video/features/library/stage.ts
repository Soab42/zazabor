import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { VideoContext } from "../../extensions";
import { isAudioPath, type Library } from "./store";
import { coverUrl } from "./widgets";

/**
 * Audio files have no picture: this fills the stage with the cover art (large, with a soft
 * shadow), the title and the artist, and clears again for video.
 */
export class StageCover {
  private readonly el = h("div", { class: "lib-stage-cover", hidden: true });
  private key = "";
  private readonly off: () => void;
  private readonly offLibrary: () => void;

  constructor(private readonly ctx: VideoContext, private readonly lib: Library) {
    ctx.stageLayer.append(this.el);
    this.off = ctx.player.subscribe(() => this.update());
    this.offLibrary = lib.onChange(() => this.update());
    this.update();
  }

  private update() {
    const path = this.ctx.player.current;
    const audio = !!path && isAudioPath(path);
    if (!audio) {
      if (this.key !== "") {
        this.key = "";
        this.el.hidden = true;
        this.el.replaceChildren();
      }
      return;
    }
    if (!this.lib.songAt(path) && !this.lib.info(path)) this.lib.wantInfo([path]);
    const cover = this.lib.coverOf(path);
    const song = this.lib.songAt(path);
    const info = this.lib.info(path);
    const album = song?.album ?? info?.album ?? "";
    const key = [path, cover, this.lib.label(path), album].join("|");
    if (key === this.key) return;
    this.key = key;

    const art = h("div", { class: "lib-stage-art" }, h("span", { class: "lib-art-ph" }, icon("music", 64)));
    if (cover) {
      const img = h("img", { alt: "", draggable: false, src: coverUrl(cover, 800) });
      img.addEventListener("load", () => img.classList.add("loaded"));
      img.addEventListener("error", () => img.remove());
      art.append(img);
    }
    const artist = this.lib.sublabel(path);
    this.el.replaceChildren(art, h("div", { class: "lib-stage-text" },
      h("div", { class: "lib-stage-title" }, this.lib.label(path)),
      artist ? h("div", { class: "lib-stage-artist" }, artist) : null,
      album ? h("div", { class: "lib-stage-album" }, album) : null));
    this.el.hidden = false;
  }

  dispose() {
    this.off();
    this.offLibrary();
    this.el.remove();
  }
}
