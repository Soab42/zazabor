import type { GuideArticle } from "../types";

export const terminal: GuideArticle = {
  id: "terminal",
  title: "Terminal",
  icon: "terminal",
  group: "media",
  summary: "Your shell in glass tabs, with split panes, find and zoom.",
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
  ],
  related: ["files", "code-editor"],
};
