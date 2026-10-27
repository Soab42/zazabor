import type { GuideArticle } from "../types";

export const gettingStarted: GuideArticle = {
  id: "getting-started",
  title: "Getting started",
  icon: "sparkles",
  group: "start",
  summary: "Zazabor puts files, photos, video, notes, money, office work and more in one app. Here's how to find your way around.",
  topics: [
    {
      title: "Your first start",
      steps: [
        "The first time Zazabor opens, a short wizard welcomes you. Press **Get started**.",
        "Pick a theme (dark, light or system) and an accent colour, then press **Next**.",
        "Turn on the features you want. You can change this any time in **Settings → Features**.",
        "Press **Start using Zazabor**.",
      ],
    },
    {
      title: "The app rail",
      steps: [
        "The slim bar on the far left is the app rail. Each button is one section: Files, Gallery, Video, Terminal, Notes, Time, Wallet, Office, Studio and Clipboard.",
        "Click a button to show that section, or press {Ctrl+1} to {Ctrl+9} for the first nine.",
        "Some buttons show a small dot: Time shows one while you're checked in, for example. Hover a button to see what it means.",
        "At the bottom, **?** opens this guide and the gear opens **Settings**.",
      ],
      tips: [
        "Right-click a section's button, or click it with the middle mouse button, to open that section in a window of its own. See [[windows|Windows]].",
      ],
    },
    {
      title: "Opening and saving files",
      steps: [
        "Every Open, Save As and Choose Folder window is Zazabor's own, in the Files look: **Favourites** and **Devices** on the left, a path bar on top.",
        "Press {Ctrl+L} to type a folder's path, or click the path bar's parts to jump up.",
        "Press {Ctrl+H} to show hidden files.",
        "Each window opens again in the folder you used last time.",
      ],
    },
    {
      title: "Getting help",
      steps: [
        "Press {F1} anywhere: the guide opens on the section you're in (inside Office or Studio, on the app that's showing).",
        "Type in the guide's search box to find any step or tip; press {Enter} to open the first match.",
        "Most buttons explain themselves when you hover them, and show their shortcut.",
      ],
      keys: [
        ["Ctrl+1", "Show the first section on the rail (up to Ctrl+9)"],
        ["Ctrl+,", "Settings"],
        ["F1", "This guide, on the section you're in"],
        ["Ctrl+N", "A new window of the section showing (in Office: a new file)"],
        ["Ctrl+L", "Lock Zazabor, when the privacy lock is set up"],
      ],
    },
  ],
  related: ["whats-new", "settings", "shortcuts", "windows"],
};
