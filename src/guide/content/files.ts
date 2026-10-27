import type { GuideArticle } from "../types";

export const files: GuideArticle = {
  id: "files",
  title: "Files",
  icon: "folder",
  group: "media",
  summary: "A Finder-style file manager: browse, preview, copy, move, search, compress and connect to servers.",
  open: { module: "files", label: "Open Files" },
  topics: [
    {
      title: "Browse your folders",
      steps: [
        "Pick a place in the sidebar: **Favourites** (your folders, and any you pin) or **Devices** (drives, phones and network shares, with how full they are).",
        "Double-click a folder to open it, or select it and press {Enter}.",
        "Use the back and forward buttons, {Alt+←} and {Alt+→}, or {Backspace} for the folder above.",
        "Click a part of the path bar to jump there, or press {Ctrl+L} and type a path.",
        "Switch between the icon, list, column and gallery views in the toolbar.",
      ],
      tips: [
        "Folders update by themselves when files change, even with 100,000 items in them.",
        "Press {Ctrl+H} to show or hide hidden files (their names start with a dot).",
      ],
    },
    {
      title: "Tabs",
      steps: [
        "Press {Ctrl+T} for a new tab, or right-click a folder and choose **Open in New Tab**.",
        "Press {Ctrl+W} to close the tab.",
        "Drag files onto a tab to move them there.",
      ],
    },
    {
      title: "Look inside a file",
      steps: [
        "Select a file and press {Space} for Quick Look: pictures, video, audio, PDF, text and code, without opening an app. Press {Space} or {Esc} to close it.",
        "Press {Ctrl+I}, or right-click and choose **Get Info**, for its size, dates, permissions and tags.",
        "Pictures open in the Gallery viewer, videos in the Video player, Word, Excel and PDF files in Office, and text and code in the code editor. Anything else opens in its default app.",
        "Right-click and choose **Open With…** to pick another app.",
      ],
    },
    {
      title: "Copy, move, rename and delete",
      steps: [
        "Copy with {Ctrl+C}, cut with {Ctrl+X} and paste with {Ctrl+V}, or drag files between folders, tabs and the sidebar.",
        "Press {F2}, or right-click and choose **Rename…**.",
        "Press {Ctrl+D} to duplicate, and {Ctrl+Shift+N} for a new folder.",
        "Press {Delete} to move to the Trash. In the Trash, **Put Back** returns a file where it was; {Shift+Delete} deletes for good.",
        "Changed your mind? {Ctrl+Z} undoes the last operation, and {Ctrl+Y} redoes it.",
      ],
      tips: ["Big copies and moves run as jobs with a progress bar. If a name is taken, Zazabor asks what to do."],
    },
    {
      title: "Search, tags and archives",
      steps: [
        "Press {Ctrl+F} and type. Choose **This Folder** or **Subfolders**, and filter by kind, date or size.",
        "Right-click and choose **Tags…** to colour-tag files; other file managers see the same tags.",
        "Right-click files and choose **Compress** to make an archive; right-click an archive and choose **Extract Here**.",
        "Right-click a folder and choose **Open Terminal Here** for a terminal in that folder.",
      ],
    },
    {
      title: "Servers and phones",
      steps: [
        "Press {Ctrl+K} (**Connect to Server…**) and type an address: smb://, sftp://, ftp:// or a WebDAV address.",
        "Phones and shares appear under **Devices** and **Network** once they're connected.",
      ],
    },
  ],
  related: ["gallery", "video-player", "code-editor", "wallet"],
};

export const codeEditor: GuideArticle = {
  id: "code-editor",
  title: "Code editor",
  icon: "fileCode",
  group: "media",
  summary: "Text and code open in a VS Code–style editor in a window of their own.",
  topics: [
    {
      title: "Open and edit",
      steps: [
        "Double-click a text or code file in Files. It opens in its own window with the folder's files in the **Explorer** on the left.",
        "Edit as in VS Code: syntax colours for dozens of languages, and IntelliSense for TypeScript, JavaScript, JSON, CSS and HTML.",
        "Press {Ctrl+S} to save. The file keeps its permissions.",
      ],
      keys: [
        ["Ctrl+S", "Save"],
        ["Ctrl+P", "Find a file in the folder"],
        ["Ctrl+G", "Go to a line"],
        ["Ctrl+Tab", "Switch tabs"],
        ["Ctrl+W", "Close the tab"],
      ],
      tips: ["The status bar shows the line and column, indentation, line endings and language."],
    },
  ],
  related: ["files", "terminal"],
};
