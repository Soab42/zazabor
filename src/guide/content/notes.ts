import type { GuideArticle } from "../types";

export const notes: GuideArticle = {
  id: "notes",
  title: "Notes",
  icon: "note",
  group: "productivity",
  summary: "Sticky notes on your desktop, with Markdown, a board or Kanban view, and sync through a cloud folder.",
  open: { module: "notes", label: "Open Notes" },
  topics: [
    {
      title: "Write a note",
      steps: [
        "In Notes, press **New Note** (or {Ctrl+N}). The note opens in a small window of its own on the desktop.",
        "Type. Markdown works as you type: \"# \" for a heading, \"- \" for a list, \"1. \" for numbers, \"[] \" for a checklist, \"> \" for a quote.",
        "Or use the formatting bar, or the keys below.",
        "The note saves by itself. Choose **Keep on Top** in its menu to keep it above other windows.",
      ],
      keys: [
        ["Ctrl+B", "Bold (Ctrl+I italic, Ctrl+U underline, Ctrl+T strikethrough)"],
        ["Ctrl+Shift+L", "Bullets (Ctrl+Shift+O numbers, Ctrl+Shift+K checklist)"],
        ["Ctrl+Shift+H", "Heading"],
        ["Tab or Shift+Tab", "Nest or un-nest a list item"],
        ["Ctrl+W", "Put the note away"],
        ["Ctrl+D", "Delete the note"],
      ],
      tips: ["Paste from Word, Google Docs or a web page and the headings, lists and links come with it. Copying from a note gives Markdown."],
    },
    {
      title: "The board",
      steps: [
        "The Notes section shows every note as a card on the **Board**, or in **Kanban (by status)** columns.",
        "Drag cards to order them; drag a card to another column to change its status. **+ Add note** adds one to a column.",
        "Search finds words in titles and text. **Pin to Top of List** puts a note first, and **Recently Deleted** keeps deleted notes for 30 days.",
      ],
    },
    {
      title: "A note from anywhere",
      steps: [
        "Go to **Settings → Notes** and press **Add Shortcut** (Super+Alt+N by default).",
        "Now that key opens a new note from any app, even when Zazabor isn't running.",
      ],
      tips: ["The Zazabor menu entry's right-click has **New Note** too."],
    },
    {
      title: "Sync between computers",
      steps: [
        "In **Settings → Notes**, press **Choose…** and pick a folder your cloud drive syncs (Google Drive, OneDrive, Nextcloud, Dropbox, Syncthing…).",
        "Each note becomes a Markdown file there; Markdown files put there become notes. **Sync Now** syncs at once.",
      ],
      tips: ["If both sides change a note, both versions are kept. An empty-looking (unmounted) folder never deletes anything."],
    },
  ],
  related: ["clipboard", "time"],
};
