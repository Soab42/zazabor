import type { FeatureFactory, MenuPlace, VideoFeature } from "../../extensions";
import type { MenuItem } from "../../../../ui/menu";
import { playlistHook } from "../../media-api";
import { createMiniFeature } from "../mini";
import { StageCover } from "./stage";
import { Library } from "./store";

/**
 * The media library as a video feature: "Add to Playlist" in the menus, the cover art on the
 * stage while music plays, and the mini player. The pages, sidebar and queue are built by the
 * module itself (`sections.ts`, `sidebar.ts`) on the same `Library`.
 */
export const createLibraryFeature: FeatureFactory = (ctx) => {
  const lib = Library.of(ctx.shell, ctx.player);
  // The module's own play also switches to the player page.
  lib.playFn = (path, queue) => void ctx.play(path, queue);
  const cover = new StageCover(ctx, lib);
  const mini = createMiniFeature(ctx);
  // A pasted IPTV/M3U address from the Network Stream dialog is kept as a playlist of channels.
  playlistHook.importPlaylist = async (url) => (await lib.addStream(url)).kind === "playlist";

  const current = () => (ctx.player.current ? [ctx.player.current] : []);

  const feature: VideoFeature = {
    menuItems(place: MenuPlace): MenuItem[] {
      const own: MenuItem[] = [];
      if (place === "open") own.push({ label: "New Playlist…", icon: "playlist", action: () => void lib.newPlaylistWith() });
      else {
        const paths = current();
        own.push({ label: "Add to Playlist…", icon: "plus", disabled: paths.length === 0, action: () => lib.addToPlaylist(paths, innerWidth / 2 - 90, innerHeight / 3) });
        if (place === "top") {
          own.push({ label: "Save Queue as Playlist…", icon: "playlist", disabled: ctx.player.queue.length < 2, action: () => void lib.newPlaylistWith(ctx.player.queue) });
        }
      }
      return [...own, ...(mini.menuItems?.(place) ?? [])];
    },
    handleKey: (e) => mini.handleKey?.(e) ?? false,
    dispose() {
      playlistHook.importPlaylist = undefined;
      mini.dispose?.();
      cover.dispose();
      lib.dispose();
    },
  };
  return feature;
};
