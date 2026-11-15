import type { GuideArticle } from "../types";

export const apps: GuideArticle = {
  id: "apps",
  title: "Apps",
  icon: "package",
  group: "system",
  summary: "Every installed app in one list, and uninstalling one the way it was installed, like Windows' Installed apps.",
  open: { module: "apps", label: "Open Apps" },
  topics: [
    {
      title: "See what's installed",
      steps: [
        "Open **Apps** on the rail. Everything in your applications menu is listed with its version, who made it, when it was installed and how much space it takes.",
        "A badge says where each one came from: **apt** (a system package), **Flatpak**, **Snap**, **AppImage**, **Home folder** (unpacked into a folder of yours), **Web app**, **Steam** or **Launcher**.",
        "Filter by kind with **All**, **System**, **Flatpak**, **Snap**, **Home Folder** and **Shortcuts**, sort by name, size or date, or search with {Ctrl+F}.",
      ],
      keys: [
        ["Ctrl+F", "Search apps"],
        ["↑ or ↓", "Move through the list"],
        ["Enter", "Open the app"],
        ["Delete", "Uninstall the app"],
        ["F5", "Look again"],
      ],
      tips: ["A **Broken launcher** is a menu entry whose program was removed some other way: remove it to tidy the menu."],
    },
    {
      title: "Uninstall an app",
      steps: [
        "Click **⋯** on its row (or right-click it) and choose **Uninstall…**.",
        "Zazabor works out what will happen and shows it first: for a system package it asks apt, so you see any other packages that would go with it.",
        "Tick **Also remove … packages that came with it** to take the extras apt installed for it and nothing else uses.",
        "Under **Its files in your home folder**, tick the settings, data and caches you want gone too. They go to the Trash.",
        "Press **Uninstall**. System packages, Snaps and Flatpaks installed for everyone ask for your password.",
      ],
      tips: [
        "AppImages, apps in your home folder and launchers go to the Trash with their menu entries, icons and login items, so **Undo** right after (or the Trash) puts them back.",
        "Anything the system needs can't be removed here: apt's own refusals and required packages are shown instead of a button.",
        "A Steam game is uninstalled by Steam, which asks you to confirm. A web app's launcher can be removed; the web app itself stays in its browser.",
      ],
    },
  ],
  related: ["files", "settings"],
};
