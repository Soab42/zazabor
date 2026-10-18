import type { IconName } from "../ui/icons";
import type { ModuleFactory, ModuleId } from "./module";

/** What the shell knows about a module before it is loaded: how it looks on the rail and in Settings. */
export interface ModuleMeta {
  title: string;
  icon: IconName;
  /** One line shown with the feature switch. */
  blurb: string;
  /** Loads the module's code on first use (each module is its own chunk). */
  load: () => Promise<ModuleFactory>;
}

export const MODULES: Record<ModuleId, ModuleMeta> = {
  files: {
    title: "Files",
    icon: "folder",
    blurb: "Browse, preview and organise folders, like a Finder for Linux.",
    load: async () => (await import("../modules/files")).createFilesModule,
  },
  gallery: {
    title: "Gallery",
    icon: "image",
    blurb: "Albums found on this computer, a deep-zoom viewer and cinematic slideshows.",
    load: async () => (await import("../modules/gallery")).createGalleryModule,
  },
  video: {
    title: "Video",
    icon: "video",
    blurb: "A calm, VLC-powered video player with a media library, streams and subtitles.",
    load: async () => (await import("../modules/video")).createVideoModule,
  },
  terminal: {
    title: "Terminal",
    icon: "terminal",
    blurb: "Your shell in glass tabs, also built into the code editor.",
    load: async () => (await import("../modules/terminal")).createTerminalModule,
  },
};
