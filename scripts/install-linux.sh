#!/usr/bin/env bash
# Installs Zazabor for the current user, no root needed: the app in ~/.local/bin, its sound
# effects in ~/.local/lib/Zazabor, and a launcher entry plus icons so it appears in the
# applications menu and in "Open With" for images, video, folders, and Word, Excel and CSV files.
# With --background it also starts Zazabor in the background at login, for the clipboard
# history (Settings → Clipboard → Run in the background does the same). PDFium (BSD-3-Clause),
# which the PDF app's true redaction and text editing load at run time, goes in ~/.local/lib/zazabor,
# fetched first with scripts/fetch-pdfium.sh (a pinned release, checksum-checked) when it isn't
# in src-tauri/pdfium yet. It removes the old SliderPro launcher, binary and icons.
#
#   scripts/install-linux.sh               build, then install
#   scripts/install-linux.sh --no-build    install the existing release build
#   scripts/install-linux.sh --background  also start Zazabor in the background at login
#   scripts/install-linux.sh --uninstall   remove everything this script installed
set -euo pipefail
cd "$(dirname "$0")/.."

bin_dir="$HOME/.local/bin"
lib_dir="$HOME/.local/lib/Zazabor"
pdfium_dir="$HOME/.local/lib/zazabor"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
desktop_file="$data_dir/applications/zazabor.desktop"
autostart_file="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/zazabor.desktop"
build=1
background=0
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --background) background=1 ;;
    --no-background) background=0 ;;
    --uninstall) ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
icon_sizes=(32 64 128 256 512)

refresh_menus() {
  update-desktop-database -q "$data_dir/applications" 2>/dev/null || true
  gtk-update-icon-cache -q -t "$data_dir/icons/hicolor" 2>/dev/null || true
}

# CorePro was Zazabor's name until 2026-10-27. A running CorePro is asked to quit first (it asks
# about unsaved Office files), so the two never run side by side; its program, launcher, icons
# and libraries go. Its settings and data stay as a backup (Zazabor copies them on first start),
# and a login entry it had becomes Zazabor's.
old_autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/corepro.desktop"
remove_corepro() {
  if [[ -x "$bin_dir/corepro" ]] && pgrep -f -x "$bin_dir/corepro( .*)?" >/dev/null 2>&1; then
    echo "Asking the running CorePro to quit…"
    "$bin_dir/corepro" --quit 2>/dev/null || true
    for _ in $(seq 1 40); do pgrep -f -x "$bin_dir/corepro( .*)?" >/dev/null 2>&1 || break; sleep 0.5; done
    if pgrep -f -x "$bin_dir/corepro( .*)?" >/dev/null 2>&1; then
      echo "CorePro is still open (an unsaved file?). Close it, then run this again." >&2
      exit 1
    fi
  fi
  rm -f "$bin_dir/corepro" "$data_dir/applications/corepro.desktop"
  rm -rf "$HOME/.local/lib/CorePro" "$HOME/.local/lib/corepro"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/corepro.png"; done
}

# SliderPro was the name before CorePro; its settings and caches are left alone (Zazabor migrates them).
remove_sliderpro() {
  rm -f "$bin_dir/sliderpro" "$data_dir/applications/sliderpro.desktop"
  rm -rf "$HOME/.local/lib/SliderPro"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/sliderpro.png"; done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  remove_corepro
  rm -f "$bin_dir/zazabor" "$desktop_file" "$autostart_file" "$old_autostart"
  rm -rf "$lib_dir" "$pdfium_dir"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/zazabor.png"; done
  remove_sliderpro
  refresh_menus
  echo "Zazabor removed. Settings and caches remain in ~/.config/dev.soab.zazabor and ~/.cache/dev.soab.zazabor."
  exit 0
fi

if [[ $build == 1 ]]; then
  npx tauri build --no-bundle
fi

remove_corepro
install -Dm755 src-tauri/target/release/zazabor "$bin_dir/zazabor"
# Soundtracks used to come with the app; they're in the content library now (downloaded when used).
rm -rf "$lib_dir/resources/music"
install -d "$lib_dir/resources/sfx"
install -m644 src-tauri/resources/sfx/* "$lib_dir/resources/sfx/"

# PDFium beside the app (Zazabor looks in ../lib/zazabor from its own folder). Without it the PDF
# app still works; only true redaction and editing existing text are unavailable.
if [[ ! -f src-tauri/pdfium/lib/libpdfium.so ]]; then
  scripts/fetch-pdfium.sh || echo "PDFium couldn't be fetched; the PDF app's redaction keeps to replacing pages with pictures." >&2
fi
if [[ -f src-tauri/pdfium/lib/libpdfium.so ]]; then
  install -Dm644 src-tauri/pdfium/lib/libpdfium.so "$pdfium_dir/libpdfium.so"
  install -m644 src-tauri/pdfium/LICENSE "$pdfium_dir/LICENSE"
fi

icon_source() {
  case "$1" in
    256) echo src-tauri/icons/128x128@2x.png ;;
    512) echo src-tauri/icons/icon.png ;;
    *) echo "src-tauri/icons/${1}x${1}.png" ;;
  esac
}
for size in "${icon_sizes[@]}"; do
  install -Dm644 "$(icon_source "$size")" "$data_dir/icons/hicolor/${size}x${size}/apps/zazabor.png"
done

mkdir -p "$(dirname "$desktop_file")"
cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=Zazabor
GenericName=Files, photos, video and office
Comment=Files, photos, video, notes, time tracking, a wallet, Word and Excel files, and clipboard history in one app
Exec=$bin_dir/zazabor %F
Icon=zazabor
Terminal=false
Categories=Utility;FileManager;Graphics;AudioVideo;
Keywords=files;folders;photo;picture;gallery;slideshow;video;viewer;notes;sticky;time;tracker;wallet;money;office;word;excel;docx;xlsx;spreadsheet;document;clipboard;emoji;
MimeType=image/jpeg;image/png;image/gif;image/webp;image/bmp;image/tiff;video/mp4;video/x-matroska;video/webm;video/quicktime;video/x-msvideo;inode/directory;application/vnd.openxmlformats-officedocument.wordprocessingml.document;application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;application/vnd.ms-excel.sheet.macroEnabled.12;text/csv;text/tab-separated-values;application/pdf;
StartupWMClass=zazabor
Actions=new-note;clipboard;quit;

[Desktop Action new-note]
Name=New Note
Exec=$bin_dir/zazabor --new-note

[Desktop Action clipboard]
Name=Clipboard History
Exec=$bin_dir/zazabor --clipboard

[Desktop Action quit]
Name=Quit Zazabor
Exec=$bin_dir/zazabor --quit
EOF

# At login, Zazabor starts with no window and keeps the clipboard history (the same entry
# Settings → Clipboard → "Run in the background" writes). CorePro's login entry carries over.
if [[ -f "$old_autostart" ]]; then
  background=1
  rm -f "$old_autostart"
fi
if [[ $background == 1 ]]; then
  mkdir -p "$(dirname "$autostart_file")"
  cat > "$autostart_file" <<EOF
[Desktop Entry]
Type=Application
Name=Zazabor
Comment=Keeps the clipboard history, quick notes and the time tracker ready
Exec=$bin_dir/zazabor --background
Icon=zazabor
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
fi

remove_sliderpro
refresh_menus
echo "Zazabor installed. Find it in your applications menu, or run: zazabor"
if [[ $background == 1 ]]; then
  echo "It starts in the background at login (Settings → Clipboard → Run in the background turns that off)."
else
  echo "For clipboard history from login, turn on Settings → Clipboard → Run in the background."
fi
