import type { GuideArticle } from "../types";

export const settings: GuideArticle = {
  id: "settings",
  title: "Settings",
  icon: "settings",
  group: "system",
  summary: "Theme, features, privacy, AI and each section's options, on one searchable page.",
  topics: [
    {
      title: "Find a setting",
      steps: [
        "Press the gear at the bottom of the rail, or {Ctrl+,}.",
        "Pick a category on the left, or type in **Search settings** to find any option.",
        "Changes apply at once; there's nothing to save. Press {Esc} or the × to go back.",
      ],
    },
    {
      title: "What's where",
      tips: [
        "**General** and **Appearance**: theme (dark, light, system), accent colour, background tone, layout and the zoom animation. **General → Default apps** chooses what opens photos, videos, PDFs, Word documents, spreadsheets and folders.",
        "**Features**: turn sections on or off. One must stay on.",
        "**Privacy**: the privacy lock. See [[privacy-lock|Privacy lock]].",
        "**AI**: your Claude API key, for reading scanned statements. See [[wallet-statements|Statements]].",
        "**Keyboard**: a reference of the shortcuts.",
        "Then a page per section: Files, Gallery, Notes (sync and the quick-note shortcut), Wallet, PDF (OCR languages), Photo (AI models), Video Editor, Clipboard (Super+V, background mode, Quit), and Video's own pages (Interface, Playback, Video, Audio, Subtitles, Library, Network, Performance, Recording & Casting).",
        "**General → Help** opens this guide. **Zazabor** has the version, updates, the library, and Feedback.",
      ],
    },
    {
      title: "Report a bug or ask for a feature",
      steps: [
        "Go to **Settings → Zazabor → Feedback**.",
        "Press **Report a Bug…** or **Request a Feature…**. A form opens on GitHub in your browser, with your Zazabor version and system already filled in.",
        "Describe what happened (or your idea) and submit it there. Nothing is sent before you do; you'll need a GitHub account.",
      ],
    },
  ],
  related: ["getting-started", "privacy-lock", "shortcuts"],
};

export const privacyLock: GuideArticle = {
  id: "privacy-lock",
  title: "Privacy lock",
  icon: "lock",
  group: "system",
  summary: "Lock Zazabor with a password so people using your computer can't browse your photos, money or notes.",
  topics: [
    {
      title: "Set it up",
      steps: [
        "Open **Settings → Privacy** and choose the **Privacy lock**: **System password** (your computer's administrator password) or **Custom password**.",
        "Choose **Lock automatically** after a few minutes without use, or never.",
        "Lock any time with **Lock now** or {Ctrl+L}.",
      ],
      tips: [
        "While locked, Zazabor hides everything and refuses to scan folders, show pictures or touch Wallet. Locking one window locks them all.",
        "Hidden albums only show while unlocked.",
        "The lock doesn't encrypt your files on disk; it keeps people out of Zazabor.",
        "Auto-lock waits while a video or slideshow plays.",
      ],
    },
  ],
  related: ["settings", "wallet"],
};

export const windows: GuideArticle = {
  id: "windows",
  title: "Windows",
  icon: "external",
  group: "system",
  summary: "Open any section or file in a window of its own; all windows share settings and the lock.",
  topics: [
    {
      title: "A section in its own window",
      steps: [
        "Right-click a section's button on the rail and choose **Open in New Window**, or click it with the middle mouse button.",
        "Or press {Ctrl+N} while the section shows (in Office, Ctrl+N makes a new file instead; in Notes, a new note).",
        "The new window shows just that section, without the rail or Settings.",
      ],
    },
    {
      title: "A file in its own window",
      steps: [
        "In Files, right-click a file and choose **Open in New Window**: a picture gets only the viewer, a video only the player, text and code the editor.",
        "Word, Excel, PDF and Studio project files opened from Files get an Office or Studio window of their own.",
      ],
      tips: [
        "Change the theme in one window and the others follow.",
        "Only one Zazabor runs at a time: opening it again, or opening a file with it from another app, brings up the running one.",
      ],
    },
  ],
  related: ["getting-started", "background-quit"],
};

export const backgroundQuit: GuideArticle = {
  id: "background-quit",
  title: "Background mode & Quit",
  icon: "moon",
  group: "system",
  summary: "Keep Zazabor running without a window (for the clipboard history), and quit it completely.",
  topics: [
    {
      title: "Run in the background",
      steps: [
        "Open **Settings → Clipboard** and turn on **Run in the background**.",
        "Zazabor now starts at login with no window, and keeps running after you close its window, so the clipboard history, quick notes and Time are always ready.",
        "Open Zazabor from the applications menu to show its window again.",
      ],
    },
    {
      title: "Quit Zazabor",
      steps: [
        "Press **Quit Zazabor** in **Settings → Clipboard**, or right-click Zazabor in the applications menu and choose **Quit Zazabor**.",
        "If an Office file has unsaved changes, Zazabor asks to save it first. **Cancel** keeps Zazabor running.",
      ],
      tips: ["From a terminal, typing zazabor --quit does the same."],
    },
  ],
  related: ["clipboard", "install"],
};

export const install: GuideArticle = {
  id: "install",
  title: "Install & update",
  icon: "download",
  group: "system",
  summary: "Install Zazabor for your user on Linux (no root needed), update it, or remove it.",
  topics: [
    {
      title: "Install or update",
      steps: [
        "In the Zazabor source folder, run scripts/install-linux.sh. It builds Zazabor and installs it into ~/.local, with an applications-menu entry.",
        "Zazabor is added to **Open With** for pictures, videos, folders, Word, Excel, CSV and PDF files. Your default apps don't change until you choose: **Settings → General → Default apps** makes Zazabor (or any other app) what opens each kind of file.",
        "Zazabor updates itself: it checks GitHub now and then and says when there's a newer version. Go to **Settings → Zazabor → Updates**, press **Install Update**, then **Restart Now**. Nothing installs without you.",
        "**Check for Updates** asks at once; turn off **Check for updates automatically** to only check by hand.",
      ],
      tips: [
        "Add --background to start Zazabor in the background at login; --uninstall removes it (your files and settings stay).",
        "The installer also fetches PDFium for the PDF app's redaction and **Edit Text** (a pinned release, checked against its checksum) and installs it into ~/.local/lib/zazabor/.",
      ],
    },
    {
      title: "Optional extras",
      tips: [
        "Video export and playback use GStreamer; some formats need extra codec packages. The Video Editor explains what's missing.",
        "PDF → Word \"Keep the layout\" and some compression options use LibreOffice and Ghostscript when they're installed.",
        "AI models and OCR languages download inside Zazabor when you first use them, after asking.",
      ],
    },
    {
      title: "Templates, music and fonts",
      steps: [
        "Zazabor comes with a few motion templates and its sound effects. The rest of its library (more templates, the soundtracks and the template fonts) downloads from Zazabor's library online the first time you use each piece, and stays on your computer.",
        "New templates and music appear by themselves within the hour; **Settings → Zazabor → Library → Check Now** looks at once.",
        "**Remove Downloads** frees the space. Anything you use again downloads again, and projects that use it fetch it when they open.",
      ],
    },
  ],
  related: ["background-quit", "pdf", "video-editor"],
};

export const shortcuts: GuideArticle = {
  id: "shortcuts",
  title: "Keyboard shortcuts",
  icon: "terminal",
  group: "system",
  summary: "The keys that work everywhere, and where to find each section's own.",
  topics: [
    {
      title: "Everywhere",
      keys: [
        ["Ctrl+1", "Show the first section (Ctrl+2 … Ctrl+9 the next ones)"],
        ["Ctrl+,", "Settings"],
        ["F1", "This guide, on the section you're in"],
        ["Ctrl+N", "A new window of the section (Office: a new file; Notes: a new note)"],
        ["Ctrl+L", "Lock Zazabor (when the privacy lock is set up)"],
        ["Esc", "Close Settings, the guide or a dialog"],
      ],
    },
    {
      title: "In each section",
      tips: [
        "[[files|Files]]: Space for Quick Look, F2 to rename, Ctrl+T for a tab, Ctrl+K to connect to a server.",
        "[[gallery|Gallery]] viewer: arrows to browse, 0 to fit, F for fullscreen, E to edit, S for a slideshow.",
        "[[video-player|Video]]: Space to play, F for fullscreen, ? for all the player's keys.",
        "[[wallet|Wallet]]: Ctrl+K quick add, Ctrl+E new transaction, Ctrl+H hide amounts.",
        "[[docs|Docs]] and [[sheets|Sheets]] use Word's and Excel's keys; [[pdf|PDF]] uses Acrobat's.",
        "[[photo|Photo]]: Photoshop's tool letters and menu keys.",
        "[[terminal|Terminal]]: Ctrl+Shift+T for a tab, Ctrl+Shift+D to split.",
        "**Settings → Keyboard** lists the main ones too.",
      ],
    },
  ],
  related: ["getting-started", "settings"],
};
