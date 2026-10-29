import type { GuideArticle } from "../types";

export const terminal: GuideArticle = {
  id: "terminal",
  title: "Terminal",
  icon: "terminal",
  group: "media",
  summary: "Your shell in glass tabs, with split panes, find and zoom, and a terminal drawer under every section.",
  open: { module: "terminal", label: "Open Terminal" },
  topics: [
    {
      title: "Use it",
      steps: [
        "Open the Terminal section; a shell starts in your home folder.",
        "From Files, right-click a folder and choose **Open Terminal Here** to start in that folder.",
        "Use the shell menu beside the tabs to pick another shell (bash, zsh, fish…).",
      ],
      keys: [
        ["Ctrl+Shift+T", "New tab"],
        ["Ctrl+Shift+W", "Close the pane"],
        ["Ctrl+Shift+D", "Split to the right"],
        ["Ctrl+Shift+O", "Split down"],
        ["Alt+←", "Move between panes (any arrow)"],
        ["Ctrl+Shift+F", "Find"],
        ["Ctrl+↑ or Ctrl+↓", "Jump between commands"],
        ["Ctrl+= or Ctrl+-", "Bigger or smaller text (Ctrl+0 resets)"],
        ["Ctrl+PgUp or Ctrl+PgDn", "Previous or next tab"],
      ],
      tips: ["Inside the terminal, other keys go to your shell (Ctrl+L clears the screen there, not lock)."],
    },
    {
      title: "The terminal drawer",
      steps: [
        "Press {Ctrl+`} (or the terminal button at the bottom of the rail) in any section: terminals open in a drawer under it, starting in that section's folder (the folder open in Files, say).",
        "Drag the drawer's top edge to make it taller or shorter; **Maximize** gives it most of the window.",
        "**Fold** (or double-click the edge) shrinks it to its tabs: what runs keeps running, an agent like Claude Code included. A tab names what's running in it.",
        "When a command finishes while the drawer is folded or hidden, its tab and the rail's terminal button get a dot: green when it worked, red when it failed. Click the strip to unfold it.",
        "{Ctrl+`} in the drawer hides it; {Ctrl+Shift+`} opens a new terminal there. The drawer stays as you left it, in every window, the next time Zazabor starts.",
      ],
      tips: ["In Sheets, {Ctrl+`} still shows formulas; use the rail's button there."],
    },
  ],
  related: ["files", "code-editor"],
};
