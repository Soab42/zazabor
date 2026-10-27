import type { ModuleId } from "../shell/module";
import type { IconName } from "../ui/icons";

/**
 * The user guide's articles are plain data (`content/`), one file per feature. Steps and tips are
 * short sentences with a little markup the guide renders: **Button or menu name**, {Ctrl+K} for
 * keys, and [[article-id|words]] for a link to another article.
 */

export type GuideGroup = "start" | "media" | "productivity" | "office" | "studio" | "system" | "new";

export const GROUP_TITLES: Record<GuideGroup, string> = {
  start: "Getting started",
  media: "Files & media",
  productivity: "Productivity",
  office: "Office",
  studio: "Studio",
  system: "System",
  new: "What's New",
};

export interface GuideTopic {
  title: string;
  /** Numbered steps, in order. */
  steps?: string[];
  /** Notes beside the steps: limits, choices, what it needs. */
  tips?: string[];
  /** Shortcuts: the keys ("Ctrl+Shift+S") and what they do. */
  keys?: [string, string][];
}

export interface GuideArticle {
  id: string;
  title: string;
  icon: IconName;
  group: GuideGroup;
  /** One line under the title. */
  summary: string;
  /** The "Open <section>" button: the section, and a part of it (Office's "sheet" page). */
  open?: { module: ModuleId; target?: string; label: string };
  /** Something the feature needs before it works, shown above the topics. */
  needs?: string;
  topics: GuideTopic[];
  /** Other articles worth reading next. */
  related?: string[];
  /** An extra button that opens something more (the video player's shortcuts sheet). */
  extra?: "playerShortcuts";
}
