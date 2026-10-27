import type { GuideArticle } from "../types";

export const clipboard: GuideArticle = {
  id: "clipboard",
  title: "Clipboard",
  icon: "clipboard",
  group: "productivity",
  summary: "Everything you copy, to paste again, like Windows' Win+V, plus emoji and symbols.",
  open: { module: "clipboard", label: "Open Clipboard" },
  topics: [
    {
      title: "Set up Super+V",
      steps: [
        "Go to **Settings → Clipboard** and press **Add Shortcut** (Super+V by default).",
        "If GNOME already uses Super+V, Settings offers to take it over or to use Super+Shift+V instead.",
      ],
      tips: ["The shortcut runs \"zazabor --clipboard\", which you can also bind yourself in your desktop's keyboard settings."],
    },
    {
      title: "Paste from the history",
      steps: [
        "Copy things as usual: text, rich text, pictures and files are kept (the last 25, plus anything pinned).",
        "In any app, press your shortcut. A small popup opens next to the pointer.",
        "Use {↑} and {↓}, then {Enter} to paste the item into the app you were typing in.",
        "Right-click an item to **Pin** it, or press {Delete} to remove it. **Clear All** keeps pinned items.",
        "Switch to the **Emoji**, **Kaomoji** or **Symbols** tabs with {Ctrl+Tab}; type to search.",
      ],
      keys: [
        ["↑ or ↓", "Move through the list"],
        ["Enter", "Paste the item"],
        ["Delete", "Remove the item"],
        ["Ctrl+Tab", "Next tab (Emoji, Kaomoji, Symbols)"],
        ["Esc", "Close the popup"],
      ],
      tips: [
        "What a password manager marks as secret is never kept.",
        "In native Wayland apps Zazabor can't paste for you: the popup copies the item and asks you to press {Ctrl+V}.",
      ],
    },
    {
      title: "The Clipboard section",
      steps: [
        "Open Clipboard on the rail for the whole history, with search and the **All**, **Text**, **Images**, **Files** and **Pinned** filters.",
        "In **Settings → Clipboard** you can turn the history off, clear it when Zazabor quits, and leave out apps (a banking app, say).",
      ],
      tips: ["The history pauses while Zazabor is locked."],
    },
  ],
  related: ["background-quit", "notes"],
};
