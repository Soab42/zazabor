import { invoke } from "@tauri-apps/api/core";
import { watchMailStatus } from "../modules/mail/status";
import { watchPhoneStatus } from "../modules/phone/status";
import { watchTimeStatus } from "../modules/time/status";
import { notesApi } from "../notes/api";
import type { IconName } from "../ui/icons";
import type { ModuleFactory, ModuleId, RailStatus } from "./module";

/** What the shell knows about a module before it is loaded: how it looks on the rail and in Settings. */
export interface ModuleMeta {
  title: string;
  icon: IconName;
  /** One line shown with the feature switch. */
  blurb: string;
  /** Loads the module's code on first use (each module is its own chunk). */
  load: () => Promise<ModuleFactory>;
  /** What "a new window" of this module is, when not the section again (Notes: a new note). */
  newWindow?: { label: string; open(): void };
  /** Keeps the module's rail dot up to date while the feature is on (before it loads, too); returns a stop function. */
  status?: (show: (status: RailStatus | null) => void) => () => void;
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
  notes: {
    title: "Notes",
    icon: "note",
    blurb: "Sticky notes on your desktop, synced through a cloud drive folder.",
    load: async () => (await import("../modules/notes")).createNotesModule,
    newWindow: {
      label: "New Note",
      open: () => void notesApi.create().then((note) => notesApi.open(note.id)).catch((err) => console.warn("Could not make a note:", err)),
    },
  },
  time: {
    title: "Time",
    icon: "stopwatch",
    blurb: "Check in, time your tasks, breaks and prayer, and write a daily report.",
    load: async () => (await import("../modules/time")).createTimeModule,
    status: watchTimeStatus,
  },
  wallet: {
    title: "Wallet",
    icon: "wallet",
    blurb: "Your money: accounts and wallets, spending and income, budgets and bills.",
    load: async () => (await import("../modules/wallet")).createWalletModule,
  },
  office: {
    title: "Office",
    icon: "office",
    blurb: "Docs and Sheets: write documents and spreadsheets that open and save Word and Excel files.",
    load: async () => (await import("../modules/office")).createOfficeModule,
  },
  studio: {
    title: "Studio",
    icon: "studio",
    blurb: "Edit photos with layers, and cut reels and videos with text, music and transitions.",
    load: async () => (await import("../modules/studio")).createStudioModule,
  },
  clipboard: {
    title: "Clipboard",
    icon: "clipboard",
    blurb: "Everything you copy, to paste again: Win+V's clipboard history, emoji and symbols.",
    load: async () => (await import("../modules/clipboard")).createClipboardModule,
    newWindow: {
      label: "Show Clipboard Popup",
      open: () => void invoke("clipboard_popup").catch((err) => console.warn("Could not show the clipboard:", err)),
    },
  },
  mail: {
    title: "Mail",
    icon: "mail",
    blurb: "All your email accounts in one inbox: read, search and answer, with each account's folders beside it.",
    load: async () => (await import("../modules/mail")).createMailModule,
    status: watchMailStatus,
  },
  phone: {
    title: "Phone",
    icon: "phone",
    blurb: "Your Android phone on this PC, like Phone Link: texts, calls, photos, files and notifications, and its screen.",
    load: async () => (await import("../modules/phone")).createPhoneModule,
    status: watchPhoneStatus,
  },
  meet: {
    title: "Meet",
    icon: "video",
    blurb: "Voice and video calls and meetings hosted from this PC: guests join from a link in their browser, and meetings record themselves.",
    load: async () => (await import("../modules/meet")).createMeetModule,
  },
  tv: {
    title: "TV",
    icon: "tv",
    blurb: "Movies and series from the DhakaFlix servers on your network, plus live channels from your own playlists, in an Apple TV style.",
    load: async () => (await import("../modules/tv")).createTvModule,
  },
  apps: {
    title: "Apps",
    icon: "package",
    blurb: "Every installed app in one list, uninstalled the way it was installed, like Windows' Installed apps.",
    load: async () => (await import("../modules/apps")).createAppsModule,
  },
};
