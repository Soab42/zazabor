<p align="center"><img src="content/site/logo.svg" width="96" height="96" alt=""></p>

<h1 align="center">Zazabor</h1>

<p align="center"><b>One calm app for your files, photos, videos and work.</b><br>
A file manager, photo gallery, video player, photo and video studio, Docs, Sheets and PDF, notes, time tracking and a wallet, in one native Linux app that keeps itself up to date.</p>

<p align="center">
  <a href="https://soab42.github.io/zazabor-content/"><b>Website</b></a> ·
  <a href="#install">Install</a> ·
  <a href="https://github.com/Soab42/zazabor/releases/latest">Latest release</a> ·
  <a href="#features">Features</a> ·
  <a href="docs/plans/content-and-updates.md">Library &amp; updates</a>
</p>

![Zazabor's Video Editor: a 9:16 reel with the Product Hero motion template on the canvas, the template library on the left and a soundtrack on the timeline.](content/site/shots/video-editor.webp)

Zazabor puts a Finder-style file manager, a Picasa-style gallery with GPU deep zoom and cinematic slideshows, a VLC-based video player, a terminal, sticky notes that sync through a cloud drive, a time tracker for your working day, a wallet for your money, Office (a Word-like word processor and an Excel-like spreadsheet that open and save Word and Excel files, and an Acrobat-like PDF app), Studio (a layered photo editor and a reel and video editor with motion templates) and a Win+V-style clipboard history in one window. Each feature can be turned on or off in Settings. Built with [Tauri 2](https://tauri.app) (Rust) and TypeScript + WebGL2.

It ships small and gets the rest when it's needed: motion templates, soundtracks and template fonts come from Zazabor's online library the first time they're used, and new ones arrive without an update. New versions of Zazabor install themselves, after you say so; every release and library file is signed and checked first.

Zazabor was called CorePro until October 2026 (and SliderPro before that); its settings, notes, wallet and other data move over on first launch, and the old folders are kept as a backup. See `docs/PLAN.md` for the roadmap and `docs/DESIGN.md` for the design rules.

## Install

On Linux (x86-64), for your user, no root needed:

```sh
curl -fsSL https://soab42.github.io/zazabor-content/install.sh | sh
```

The installer reads the latest release from GitHub, checks its signature against Zazabor's release key (with OpenSSL 3, or Python's `cryptography`; it stops if it can't) and the archive's SHA-256, then installs Zazabor into `~/.local` with an applications-menu entry. Zazabor needs WebKitGTK 4.1, GStreamer and VLC's libraries; on Ubuntu, Pop!_OS or Debian: `sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-good gstreamer1.0-libav vlc`.

**Updates:** Zazabor checks for a new version a little after it starts and twice a day (Settings → Zazabor → Check for updates automatically), and says when there's one. **Install Update** downloads and installs it, and **Restart Now** quits as Quit does, asking about unsaved files first. Copies older than 0.2.0 have no updater: install 0.2.0 or later once by hand.

To build and install from source instead, see [Install from source](#install-from-source-no-root-needed).

## Features

**App**
- An app rail switches between Files, Gallery, Video, Terminal, Notes, Time, Wallet, Office, Studio and Clipboard (Ctrl+1…9 for the first nine); Settings sits at the bottom of the rail.
- Every Open, Save As and Choose Folder dialog is Zazabor's own, in the Files look (Favourites, Devices, path bar, list and icon views, type filter, search, hidden files with Ctrl+H, New Folder, multi-select), never the desktop's; each one reopens in the folder it was last used in.
- A first-run wizard picks the theme, accent colour and which features to turn on.
- **Default apps** (Settings → General): make Zazabor what opens your photos, videos, PDFs, Word documents and spreadsheets everywhere on the desktop with one button, or choose any app for each kind, folders included.
- **Feedback** (Settings → Zazabor): Report a Bug and Request a Feature open GitHub's forms with your version and system filled in.
- **Terminal drawer** (Ctrl+` or the rail's terminal button): terminals under every section, starting in that section's folder, for a shell or an agent like Claude Code beside your work. Drag its top edge to resize, fold it to its tabs (what runs keeps running; a finished command puts a dot on its tab and on the rail's button), or maximize it. Ctrl+Shift+` opens a new one.
- **Updates and the library**: Settings → Zazabor shows the version, checks for updates, installs one and restarts into it. Its Library section shows the online library (templates, soundtracks, fonts and when it was last updated), with Check Now for new ones at once and Remove Downloads to free the space (anything used again downloads again; projects that use it fetch it when they open).
- Frosted-glass macOS-style interface in dark, light or system theme, with accent colours and background tones.

**Windows**
- Any section can open in its own window (right-click its rail button, a middle click, or Ctrl+N): just that section, without the app rail or Settings. Any file can too (right-click → Open in New Window, or New Window in Quick Look): a picture gets only the viewer, a video only the player, a folder the file manager, PDFs and other files a viewer, text and code the editor.
- Windows share settings and the privacy lock: change the theme in one and the others follow; locking one locks them all.
- One Zazabor runs at a time: opening it again (from the menu, or a file with Open With) brings up the running one, which opens that file. An installed Zazabor and a development build stay separate.

**Notes**
- Sticky notes like Microsoft Sticky Notes: each note floats on the desktop in a small frameless window of its colour (yellow, green, pink, purple, blue, gray, charcoal; new notes take yellow to blue in turn), remembers where it was, and can stay on top of everything. Notes left open come back at the next start.
- Full Markdown: headings, bulleted, numbered and checklist items (nested with Tab), quotes, code blocks, rules and tables; bold, italic, underline, strikethrough, `code`, links and images. Type it as Markdown ("# ", "- ", "1. ", "[] ", "> ", then "```" or "---" and Enter) or use the formatting bar; links open with Ctrl+click.
- Paste Markdown (from a .md file or VS Code) and it's formatted; paste from Google Docs, Word or a web page and headings, lists, links and tables come with it. Copying from a note gives Markdown.
- Notes can have a title (over the text, in bold), shown on cards and as the window's name.
- Undo and redo with Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y), or the buttons at the start of the formatting bar. Typing runs together into one step until a pause, a move of the caret or a new line; formatting, lists, ticked boxes, pastes and Markdown shortcuts are steps of their own, so undo after "- " turns a new list back into the "- " you typed. The selection comes back with each step.
- The Notes section shows every note as a card on a masonry board (each card as tall as its note, no gaps), or in full-height **Kanban** columns by status. Drag cards to put them in any order, on the board or in a column (a shadow card shows where one will land); drag a card to another column to change its status, "+ Add note" in a column, and rename, reorder, add or delete columns (To do, In progress and Done to start). Search covers titles and text, pinned notes come first, checklist items tick right on a card, and Recently Deleted keeps deleted notes for 30 days.
- **Quick note from anywhere:** `zazabor --new-note` opens one new note without the rest of Zazabor (a running Zazabor opens it at once). Settings → Notes binds it to a desktop shortcut (Super+Alt+N by default); the menu entry's right-click has New Note too.
- **Sync:** pick a folder in Settings → Notes (Google Drive or OneDrive connected in GNOME Online Accounts, Nextcloud, Dropbox, Syncthing…). Each note is a Markdown file there, readable on the drive's website and on your other computers; a Markdown file written there becomes a note. Edits on both sides keep both versions, and an unmounted (empty-looking) folder never deletes anything.

**Time**
- Check in to start your working day and check out at the end; the rail's Time button shows a dot while you're checked in (pulsing while a task timer runs, amber on a break) and its tooltip says what runs and how long you've worked today.
- Time a task: pick one of your tasks in progress (Development or Meeting; add a task with its project right in the list, mark one done from there) with an optional note, starting now or at an earlier time since you checked in.
- One click logs a Short Break, Lunch, Prayer, Meeting or another activity (with a short label). Starting one while a task timer runs pauses the timer, and ending it starts the same task again. Only one thing runs at a time; checking out stops it.
- Eight counters tick every second: Total, Work, Break, Prayer, Lunch, Meeting, Others, and Idle (checked in with nothing running).
- The log of today, or all time between two days: filter by Work or Breaks & Prayer, search tasks, projects and descriptions. Log a work session or an activity that already happened; edit or delete any entry (overlaps, future times and an end before the start are refused).
- A daily report written from the day's entries (check-in and check-out, time per task with its notes, breaks, idle time): edit it, regenerate it, copy it, save it as a draft or submit it. One per day; step back through earlier days.
- A day left checked in closes at midnight. Everything stays on this computer (`time/time.json` in Zazabor's data folder) and every window shows the same timers.

**Wallet**
- Your money in one place: cash, bank accounts, cards, savings and mobile wallets (bKash, Nagad, Rocket), with opening balances. Amounts are kept as whole poisha (never rounded floats), in taka with lakh and crore grouping (৳1,25,000), and other currencies at a rate you type.
- Quick add from the bar (Ctrl+K): "250 lunch bkash" or "+45000 salary city bank 25 oct" become a transaction, with chips showing the guess before Enter (Tab opens the full form). Transfers between your own accounts take an optional fee (a bKash cash-out charge goes to Fees).
- Overview, Transactions (grouped by day with day totals, filters, search, multi-select with the selection's sum), Accounts, monthly Budgets per category (amber at 80%, red past 100%) and Reports (spending by category, income and spending per month, net worth), each chart with a table view.
- Hide amounts (Ctrl+H) for sharing your screen; the privacy lock hides Wallet entirely. A backup is made every day (the last 14 kept) and can be restored from Accounts or Settings → Wallet.
- **Bills**: recurring bills and income (rent, DESCO, Netflix, salary) that either post themselves or remind you, and catch up on every period missed while Zazabor was closed; a Bills view and a "Coming up" card. Budgets can roll unspent money over to the next month, and categories can be archived.
- **Receipts**: attach a photo or PDF to a transaction (from its form, by dropping it, or from Files' right-click menu); Wallet keeps its own copy, so moving the original doesn't lose it.
- **Import and export**: a CSV or Excel statement is mapped on its own (date, description, money in and out, day/month order), categorised by your rules and past payees, and checked for duplicates, so importing the same statement twice adds nothing; Undo removes a whole import. Exports CSV, Excel (a sheet per month) or JSON.
- **Earnings from Time**: hourly rates per project in Settings → Wallet turn Time's hours into an Earnings card, recorded as income once per month.
- **Upload a statement**: drop a bank or bKash/Nagad statement (PDF, CSV or Excel) on Import & Export. Zazabor reads it on this computer, finds or creates the account (bank and the last four digits), categorises and de-duplicates the rows, and checks the balance (opening + credits − debits = closing, row by row); rows that don't add up are flagged, never changed. One click imports, Undo takes it back, and "Import automatically when the balance check passes" can skip the review. Scans and photos of statements are read by Claude when you turn it on in Settings → AI (your own API key, kept in the system keyring; the statement is sent to Anthropic only then). Save as Excel gives a workbook with a summary sheet and flagged rows marked.

**Office**
- Like the Microsoft 365 app: an inner rail with Home, New and Open, a page each for Docs, Sheets and PDF, then the files open right now (a dot marks unsaved ones). Home and Open list recent and pinned files. Word and Excel files opened in Files get an Office window of their own.
- **Docs** works like Word: a ribbon (Home, Insert, Layout, Review, View, and a Table tab in a table), white pages with real margins and zoom, fonts (including Bangla), styles, lists and checklists, tables, pictures, links, page breaks, Find and Replace, Format Painter, word count and printing (Print to File makes a PDF). Pictures are placed as in Word (Picture Format tab, or the Layout Options button beside a picture): In Line with Text, Square, Top and Bottom, Behind or In Front of Text, dragged anywhere or nudged with the arrow keys, positioned left, centre or right, sized in centimetres, rotated, flipped and given alt text, and saved that way in .docx. Opens .docx, .md, .txt and .html; saves .docx, .html, .md and .txt. When a Word file has parts Docs can't keep (headers and footers, footnotes, comments…), saving over it asks first and offers to save a copy.
- **Sheets** works like Excel, on the [IronCalc](https://github.com/ironcalc/IronCalc) engine: the ribbon (Home, Insert, Page Layout, Formulas, Data, Review, View), name box and formula bar, the grid with frozen panes, merged cells, borders, fills, number formats (taka, accounting, dates, percentages), wrap and alignment, conditional formatting (rules, data bars, colour scales, icons), the fill handle, sort, AutoFilter, Find and Replace, Go To, defined names, Format Cells (Ctrl+1), sheet tabs (add, rename, colour, move, hide, delete) and printing. Formulas autocomplete from all 489 functions the engine has, references are picked by clicking or dragging (Point mode) and outlined in colour, and the status bar sums the selection. Opens and saves .xlsx, .csv and .tsv; a 20,000-row workbook opens in about a third of a second.
- **PDF** works like Acrobat Reader, on pdf.js: page thumbnails, bookmarks, the comments list and attachments, Find, zoom, two-page and Read Mode, dark pages, password-protected files and printing. Comment adds highlights, text boxes, drawing and pictures; Fill & Sign fills forms and places today's date, check marks and signatures (typed, drawn or from a picture, kept for next time; pictures on the page, not certificate signatures). Organize moves, rotates, deletes, inserts, extracts and splits pages; New combines PDFs and pictures into one file or turns pictures into a PDF. Saving keeps the file's links, forms and comments.
- PDF also underlines, strikes through and squiggles text, adds sticky notes and shapes (rectangle, oval, line, arrow, polygon) that other PDF readers show, and deletes any comment. **Edit** adds text and pictures to the page, watermarks, headers and footers and Bates numbers, and flattens comments and forms. **Protect** sets an AES-256 password and permissions (and removes them), removes hidden information (metadata, attachments, scripts), reduces the file size, and redacts: marked areas or found text (phone numbers, emails, ID numbers) are removed from the file with PDFium: only the marked text, pictures and shapes go, the rest of the page stays real text, and a check afterwards makes sure nothing marked is left (turning the pages into pictures is still a choice). **Edit Text** changes a line of existing text in its own font.
- **Scan & OCR** makes scanned pages searchable and selectable in English and Bangla (the language data downloads once). **Certificate** signs with a .p12/.pfx certificate (PAdES, verified by other readers), and the Signatures panel shows whether each signature still covers the file. **Convert** turns a PDF into a Word document, a bank statement or any tables into Excel. Comments take replies, as in Acrobat.
- Templates: letter, report, resume and meeting notes; monthly budget, invoice, to-do list and timesheet.
- **File** opens the backstage, as in Word and Excel: Home, New and Open, then Info (location, size, pages or sheets), Save, Save As (formats), Print (with a preview of the pages), Export (PDF, other formats) and Close; the arrow or Esc goes back to the file. Ctrl+N makes a new file of the same kind, Ctrl+O opens, Ctrl+W closes, and closing the window asks about unsaved files. AutoRecover keeps a copy of each unsaved workbook every 20 seconds; if Zazabor stops without saving it (a crash, a power cut), Home offers it back under Recovered.

**Studio**
- Like Office, an inner rail with Home, Photo and Video, then the projects open right now. Home starts a new canvas or a reel in 9:16, 16:9, 1:1 or 4:5, and lists recent projects. Projects save as `.zazimage` (Photo) and `.zazvideo` (Video Editor); older `.coreimage` and `.corevideo` files still open, and any of them opened in Files gets a Studio window of its own.
- **Photo** works like Photoshop: menus, options bar, tools, and Adjustments, Layers and History panels. Pixel and adjustment layers with all 27 blend modes, opacity, reorder, merge and flatten; move, crop, brush and eraser (size, hardness, flow, pen pressure), gradient, paint bucket, eyedropper; Auto Tone, Image Size, rotate and flip; 200 steps of history. Layer masks, groups and clipping masks; selections (marquees, lassos, Magic Wand, Color Range, feather, expand, inverse) that tools, filters and adjustments respect; cut, copy and paste to new layers; twelve adjustment layers (Levels, Curves, Hue/Saturation, Colour Balance, Black & White and more); type and shape layers; Free Transform; Gaussian and Motion Blur, Unsharp Mask, Noise; Clone Stamp and Healing Brush. Opens PNG, JPEG, WebP, TIFF, BMP, GIF and Photoshop's .psd, keeps each picture's colour profile, saves its own `.zazimage` (layers and all) or .psd and exports JPEG, PNG, WebP, AVIF, TIFF or BMP. AI tools run on this computer (models download once, after asking): Remove Background and Select Subject as a layer mask, Object Selection by clicking, Remove (paint over an object to erase it), plus Refine Edge. RAW photos (Canon, Nikon, Sony, Fuji, DNG and more, through LibRaw) open with a Develop panel: white balance, exposure, highlights, shadows, sRGB or Display P3.
- **Video** works like CapCut for short reels: a timeline with a magnetic main track, overlays, texts and music, thumbnails and waveforms, snapping, split (S), trim, ripple delete and undo. The preview plays everything live on the GPU: fill or fit over a blurred background, Ken Burns on pictures, the slideshow's looks and all 50 of its transitions, and texts in 8 styles with animations. Exports 720p or 1080p MP4 (H.264 on the Intel GPU, with MP3 sound because this system has no AAC encoder) or WebM (VP9 and Opus), and saves a `.zazvideo` project. Keyframes (position, scale, rotation, opacity, volume) with easing, picture in picture, chroma key, colour tables (.cube), effects and masks, reverse, freeze frame and speed curves; voice-over, music that ducks under the voice, beat marks and .srt captions. Moved files are found again on open, AutoRecover keeps unsaved reels, and the Gallery's slideshow setup can Make a Video from the chosen photos. Auto captions (English, with the spoken word lit up; the speech model downloads once), 32 stickers and 12 sound effects of Zazabor's own, NVIDIA encoding when its driver is there, and "Install codecs…" for AAC and x264.
- **Motion Templates**: a Templates tab of 56 animated scenes for product videos and reels in 12 categories (product launch, sale and offers, feature highlights, app and tech, testimonials, fashion, food, real estate, festive, logo reveals, lower thirds, reel hooks and end screens), each in every shape. Six come with Zazabor; the rest, and new ones as they're published, come from the online library (they're small: all of them download with the library, so projects open offline). The categories scroll with the mouse wheel. Fill in the words, product photo (with Cut out product) and logo; text fits itself, letters animate one by one (Bangla letters kept whole), with springs, light sweeps and motion blur. **Brand Kits** keep your colours, two fonts, logo, roundness and motion feel, and restyle every template in a project at once; kits save, share as `.zazkit`, and one can be the default. Save to My Templates, Save as Poster, or Ungroup to layers. 28 font families (OFL, free for commercial use), Bangla ones included: six ship with Zazabor, the others download the first time a template uses them.
- **Screen Recorder** (an early preview): Studio → Record Screen or `zazabor --record` records a screen (or all of them), a window or an area, with system sound, the microphone and a camera bubble, then trims and opens it in the Video Editor. Recordings go to Videos → Recordings.

**Help**
- A user guide inside the app: press **F1** (it opens on what you're doing), the **?** on the rail, or Settings → General → Help. Searchable articles with steps, keys and an Open button for every feature.

**Clipboard**
- Like Windows' Win+V: everything you copy (text, rich text, pictures, files) is kept, the last 25 plus anything pinned; copying the same thing again moves it to the top, and what a password manager marks as secret is never kept.
- A small popup next to the pointer (`zazabor --clipboard`, bound to a desktop shortcut in Settings → Clipboard, Super+V by default; when GNOME already uses Super+V, Settings offers to take it over or use Super+Shift+V) lists them: arrows and Enter paste the item into the app you were typing in. Emoji, Kaomoji and Symbols tabs with search and a recently used row. Pin, delete or clear all (pinned items stay).
- **Run in the background** (Settings → Clipboard): Zazabor starts at login with no window and keeps running after its window closes, so the history records everything you copy; opening Zazabor again shows its window. Quit Zazabor (in Settings → Clipboard, the menu entry's right-click, or `zazabor --quit`) stops it, asking first about unsaved Office files.
- The Clipboard section shows the whole history with search and filters (Text, Images, Files, Pinned). History can be turned off, cleared on exit, and skips apps you exclude; it pauses while Zazabor is locked. Pasting into native Wayland apps isn't possible yet: there the popup copies and says to press Ctrl+V.

**Code editor**
- Text and code open in a VS Code–style editor (Monaco, the editor VS Code is built on) in their own window: the project's Explorer, tabs with unsaved dots, breadcrumbs, a minimap, Ctrl+S to save (safely, keeping permissions), Ctrl+P to find a file, Ctrl+G to go to a line, and a status bar for position, indentation, line endings and language. Syntax colouring for dozens of languages, with IntelliSense for TypeScript, JavaScript, JSON, CSS and HTML.

**Files**
- Finder-style browsing: Favourites and Devices in the sidebar (including phones and network shares mounted by GVfs, with capacity meters), a clickable path bar, tabs, back/forward, and live updates when folders change.
- Icon, list, column and gallery views, all virtualized for folders with 100,000 items; image thumbnails, sorting, instant search and hidden files on demand.
- Images open in the Gallery viewer; videos open in the Video player; other files open with their default app or any app from Open With.
- File operations run as jobs with progress, conflict prompts and undo: copy, move, rename, duplicate, new folder, Trash (freedesktop, with Put Back), and drag and drop between folders, tabs and the sidebar.
- Quick Look (Space, or a double-click) for images, video, audio, PDF, text and code; Get Info; colour tags shared with other file managers.
- Search with scope (this folder or subfolders) and filters for kind, date and size; zip/tar compress and extract.
- Connect to Server (Ctrl+K) for SMB, SFTP, FTP and WebDAV; phones and shares appear under Devices and Network.

**Video**
- A libVLC player with the VLC redesign's interface: a control bar with the seek bar, hover previews from the film's frames, chapter and bookmark ticks, and a volume cone.
- **Liquid Glass** as in macOS 26 (on by default; Settings → Video → Interface): the controls float over the picture as glass capsules that really bend and blur the video beneath them (drawn by the player's own WebGL renderer), with light catching their rims, a glow under the pointer, a press that swells, and a seek bead that becomes a clear lens while dragged. They melt away while the video plays and the mouse rests, and come back on any movement. Off gives the docked bar.
- Quick access on the bar: subtitle tracks, audio tracks and the output device, the Queue, and a side panel with Subtitles, Audio, Video, Playback and Bookmarks tabs.
- The screen doesn't dim, blank or lock while a video plays (or a slideshow runs), and the privacy lock's auto-lock waits too.
- Subtitles drawn by Zazabor: Add Subtitles for a file, folder or queue (auto-matched to episodes), a timeline you drag to fix the timing, styling and per-show presets.
- Audio delay and an equalizer with presets; video filters with live previews, flip, rotate, zoom, aspect ratio and HDR tone mapping; speed, sleep timer and file details.
- An automatic library: Home with Continue watching, Videos, Music (songs, albums, artists, genres), Network Streams (a pasted M3U address becomes a playlist of channels), Playlists and Recent.
- A compact library beside the video with drag into the queue, a mini player, a continue-where-you-left-off prompt, and on-screen messages that name the key you pressed.
- Separate dialogs for Network Stream, Capture Device, From Clipboard, Recent Media, Convert and Stream to Device; profiles for layout and settings; a drag-and-drop control bar editor; a first-run intro.

**Gallery**
- Finds your photos automatically, like a phone gallery: it scans your home folder and connected drives, skipping hidden folders, app data, code projects and icon-sized images. Results are cached, so albums appear instantly on the next launch.
- Album covers, an "All photos" view, search, sort by date or name, and hidden albums.
- A Google Photos-style justified grid: photos keep their proportions in rows that fill the width (or square tiles, if you prefer).
- Extra folders can be added by hand or dropped onto the window.
- EXIF orientation is respected everywhere.

**Quick Edit** (the viewer's Edit button, or E)
- Like Google Photos: crop with ratios, straighten, rotate and flip; Auto; light and colour sliders; the slideshow's looks as filters; vignette; hold \ to compare with the original. Save a copy writes `IMG_1234 (edited).jpg` next to the original (saving over it asks first), and Open in Photo carries the edit into Studio as an adjustment layer.

**Viewer**
- GPU-rendered zoom up to 12,800%, with a pixel grid and crisp pixels at high magnification, and a colour readout under the cursor.
- Cubic-bezier zoom anchored at the cursor; repeated wheel notches and held keys hand their speed on, so zooming glides instead of stuttering. Inertial panning, minimap navigator, filmstrip, crossfades between photos.
- Controls stay in the top and bottom bars, off the photo; in fullscreen they float over it and fade away.
- Info panel with an RGB histogram and camera metadata (camera, lens, exposure, GPS…).

**Slideshows**
- 11 themes: Cinematic, Modern, Action, Neon, Adventure, Travel, Dreamy, Elegant, Memories, Playful and Noir, plus a Custom style that keeps your own timing, look and music with your own mix of transitions.
- 50 WebGL transitions in 8 families (classic, light, motion, zoom & spin, 3D, liquid & organic, geometric, digital), with a live preview of each.
- Ken Burns motion up to 200% with smart framing (landscapes fill the frame; portraits float over a blurred backdrop). Filled photos get subject-aware camera moves: the camera finds the sharpest, most colourful part of each photo and pushes in, pulls back, trucks, tilts, glides or drifts with a gentle roll, a different move for each photo.
- Colour grades, film grain, vignette, 2.39:1 letterbox, title cards and captions.
- Ten original soundtracks (synthesised by `tools/make_music.py`, free to ship), from the online library: each downloads the first time it's played or added, then stays. Cuts can land on the beat. Your own music works too.

**Settings**
- A searchable Settings page: theme, accent and background tone; grid layout, gap and corners; the zoom animation curve (presets or your own cubic-bezier); custom CSS; features on/off; Files options; the privacy lock; a keyboard reference. Changes apply live.

**Privacy lock**
- Lock the app with this computer's administrator password (system polkit dialog) or a custom password (stored as an Argon2 hash).
- While locked, the backend refuses to scan folders or serve any image; hidden albums become private. Auto-lock after inactivity, or press Ctrl+L.
- The lock keeps people using the computer from browsing your photos; it does not encrypt files on disk.

## Keyboard

| Where | Keys |
| --- | --- |
| App | Ctrl+1…9 to switch features, Ctrl+N for a new window of the current one (in Notes: a new note), Ctrl+L to lock, F1 for the guide, Ctrl+` for the terminal drawer (Ctrl+Shift+` for a new terminal in it) |
| Editor | Ctrl+S to save, Ctrl+P to open a file, Ctrl+G to go to a line, Ctrl+Tab to switch tabs, Ctrl+W to close a tab |
| Files | Enter to open, Alt+← → to go back/forward, Alt+↑ or Backspace for the parent folder, Ctrl+T/W for tabs, Ctrl+L to type a path, Ctrl+F to search, Ctrl+H for hidden files |
| Gallery | Arrows to move, Enter to open, Ctrl+F to search, F5 for a slideshow, Ctrl+L to lock |
| Viewer | ← → to browse, ↑ ↓, +/− or wheel to zoom (hold to glide), 0 to fit, 1–8 for 100%–12,800% (without Ctrl), R to rotate, I for info, F for fullscreen, S for a slideshow |
| Slideshow | Space to pause, ← → to skip, M to mute, S for settings, C for captions, Esc to exit |
| Time | Ctrl+F to search the log, Esc to clear it; in a dialog, Enter saves (Ctrl+Enter in a text box) and Esc closes |
| Sheets | Excel's keys: arrows, Ctrl+arrows to the edge, Shift to extend, Enter/Tab to move (Enter after Tabs goes back to the first column), F2 to edit, Alt+Enter for a new line in a cell, Ctrl+Enter to fill the selection, Ctrl+D/R to fill down/right, Alt+= for AutoSum, Shift+F3 to insert a function, Ctrl+1 for Format Cells, Ctrl+Shift+L for a filter, Ctrl+; for today, Ctrl+` to show formulas, Ctrl+PgUp/PgDn between sheets, Shift+F11 for a new sheet |
| Docs | Word's keys: Ctrl+B/I/U, Ctrl+L/E/R/J to align, Ctrl+Shift+> and < for the font size, Ctrl+K for a link, Ctrl+Enter for a page break, Ctrl+F/H to find and replace, Ctrl+P to print |
| Wallet | Ctrl+K for quick add, Ctrl+E for a new transaction, Ctrl+H to hide amounts, Ctrl+F to search |
| Note | Ctrl+N for a new note, Ctrl+W to put it away, Ctrl+D to delete it, Ctrl+Z to undo, Ctrl+Shift+Z or Ctrl+Y to redo, Ctrl+B/I/U/T for bold, italic, underline and strikethrough, Ctrl+Shift+L/O/K for bullets, numbers or a checklist, Ctrl+Shift+H for a heading, Ctrl+Shift+Q for a quote, Ctrl+Shift+C for a code block, Tab/Shift+Tab to nest list items |
| Video | Space or K to play/pause, ← → to skip (Shift for longer), ↑ ↓ for volume, M to mute, F for fullscreen, N/P for next/previous, [ ] for speed, G/H for subtitle delay, Ctrl+B for a bookmark, Ctrl+H to hide the UI, Ctrl+M for the mini player, ? for all shortcuts |

## Install from source (no root needed)

```sh
scripts/install-linux.sh              # builds, then installs into ~/.local with a menu entry
scripts/install-linux.sh --no-build   # installs the release build that's already there
scripts/install-linux.sh --background # also start Zazabor in the background at login (clipboard history)
scripts/install-linux.sh --uninstall
```

This adds Zazabor to your applications menu and to "Open With" for images, videos, folders, Word, Excel, CSV and PDF files (it removes the older CorePro and SliderPro launchers, asking a running CorePro to quit first). It also installs PDFium (Google's PDF engine, BSD licence) into `~/.local/lib/zazabor/` for the PDF app's redaction and text editing: `scripts/fetch-pdfium.sh` fetches a pinned release and checks its SHA-256 (without it those two tools fall back or say why). Photo builds LibRaw from its vendored source (`src-tauri/vendor/`). To build `.deb`/`.rpm` packages instead, run `npm run tauri build`.

## Feedback

Found a bug, or have an idea? [Report a bug](https://github.com/Soab42/zazabor/issues/new?template=bug_report.yml) or [request a feature](https://github.com/Soab42/zazabor/issues/new?template=feature_request.yml) on GitHub. In Zazabor, **Settings → Zazabor → Feedback** opens the same forms with your version and system filled in.

## Development

Requirements: Rust (stable), Node.js 20+, and on Linux the WebKitGTK 4.1 development packages ([Tauri prerequisites](https://tauri.app/start/prerequisites/)) plus libVLC for the video player (`sudo apt install libvlc-dev vlc`).

```sh
npm install
npm run tauri dev               # run in development
npm run tauri build             # build installers
npm run typecheck
node --test tools/*.test.mjs    # motion templates, the content library, the Video Editor, export, photo tones
cd src-tauri && cargo test      # backend tests
```

Regenerate the soundtracks into `content/music` (needs numpy and GStreamer's `gst-launch-1.0` with vorbisenc), then publish the library:

```sh
python3 tools/make_music.py
```

### Publishing: the library and releases

Everything published is signed with the release key, an Ed25519 key made once with `node tools/release/sign.mjs keygen` and kept at `~/.config/zazabor-release/signing-key.pem`, never in the repository. Its public half is in `src-tauri/src/signing.rs`. **Back the key up:** without it, no update or library change can reach the copies already installed.

```sh
tools/content/publish.sh                     # the library and the website (GitHub Pages of Soab42/zazabor-content)
scripts/release.sh 0.3.0 "What's new"        # a release that installed copies update to
scripts/release.sh 0.3.0 "What's new" --dry-run   # build and pack only, publish nothing
```

- **The library** holds every motion template (their sources are in `src/modules/studio/video/motion/templates`, listed in `templates/index.ts`), the soundtracks (`content/music`), the template fonts (`content/fonts`; the six starter families are in `public/fonts`) and extra sound effects (`content/sounds`). `publish.sh` builds it into `content-dist/` with a signed catalog and pushes it; running copies pick it up within the hour.
- **The website** (`content/site`: the product page, its screenshots and `install.sh`) is published with the library. It reads the catalog for its numbers, categories and playable soundtracks.
- **A release** sets the version, builds, packs the program with its sound effects, signs `latest.json`, commits and tags the version, and creates the GitHub release. It needs a clean working tree.

How it all fits together, and how to test against a local server (`ZAZABOR_CONTENT_URL`, `ZAZABOR_UPDATE_URL`), is in [`docs/plans/content-and-updates.md`](docs/plans/content-and-updates.md).

## Project layout

- `src-tauri/src` — Rust backend: the file manager's commands (`fs/`), sticky notes and their folder sync (`notes/`), time tracking (`time/`), the wallet's SQLite ledger (`wallet/`), Office's file reading and writing (`office/`: raw bytes, .xlsx through the `ironcalc` crate, CSV, AutoRecover, saved PDF signatures), the clipboard history and its popup (`clipboard/`: GTK's clipboard, XTest for pasting), Photo's decoding, encoding and project files (`photo/`), the Video Editor's GStreamer decoding, sound and export (`videoedit/`), keeping the screen awake (`awake.rs`), folder discovery (`scan.rs`), photo sizes (`dims.rs`), decoding, thumbnails and EXIF (`imaging.rs`), the `cs://` protocol (`protocol.rs`), the lock (`lock.rs`), the move from the earlier names, CorePro and SliderPro (`migrate.rs`), and the content library and updates (`content.rs`, `update.rs`, with `signing.rs` for the release key and `download.rs` for resumable, checked downloads).
- `src/shell` — app rail, module registry, Settings page, first-run wizard, update checks (`updates.ts`), the terminal drawer (`drawer.ts`), default apps (`defaults.ts`) and feedback (`feedback.ts`); `module.ts` is the contract every feature implements. `src/content.ts` is the content library on the page's side (the catalog, downloads, soundtracks).
- `src/modules/files` — the file manager: browser, sidebar, path bar, tabs, and the four views (`views/`).
- `src/modules/gallery` — albums and the virtualized photo grid (`library/`), the zoom viewer (`viewer/`), slideshows (`slideshow/`).
- `src/modules/video` — the video player.
- `src/modules/notes` — the Notes section; `src/notes` — the note window, its editor and the Markdown a note is saved as.
- `src/modules/wallet` — the Wallet section: views, quick add, charts.
- `src/modules/office` — Office: the inner rail and Home (`index.ts`, `hub.ts`), the ribbon Docs and Sheets share (`ribbon.ts`), the editor contract (`editor.ts`), Docs (`docs/`, Tiptap), Sheets (`sheets/`: the canvas grid, cell editing, commands, AutoFilter, printing, on `@ironcalc/wasm`) and PDF (`pdf/`: pdf.js's viewer and editors, page organizing and combining).
- `src/modules/studio` — Studio: the inner rail and Home (`index.ts`), the app contract (`app.ts`), Photo (`photo/`: the WebGL2 layer engine, tools, panels) and the Video Editor (`video/`: the timeline model and canvas, the WebGL2 compositor, the inspector, export).
- `src/modules/time` — the Time section: counters, activity chips, the log, its dialogs and the daily report; `model.ts` holds the totals and the report text.
- `src/clipboard`, `src/modules/clipboard` — the clipboard popup (with emoji) and the Clipboard section.
- `src/shared/statements`, `src-tauri/src/statements` — reading bank statements (PDF layout, CSV/XLSX, Claude for scans), the balance check and the Excel export; `src/shared/ai` — Settings → AI.
- `src/shared`, `src/ui` — thumbnail loader, Zazabor's own file dialogs (`shared/dialog.ts`, `shared/filepicker/`), DOM helpers, icons, menus.
- `content/` — what the online library publishes: `music/`, `fonts/`, `sounds/`, and the website `site/`. `tools/content/` builds and publishes it; `tools/release/sign.mjs` signs; `scripts/release.sh` releases.
