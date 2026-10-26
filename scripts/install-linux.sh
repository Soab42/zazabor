#!/usr/bin/env bash
# Installs CorePro for the current user, no root needed: the app in ~/.local/bin, its bundled
# soundtracks in ~/.local/lib/CorePro, and a launcher entry plus icons so it appears in the
# applications menu and in "Open With" for images, video, folders, and Word, Excel and CSV files.
# With --background it also starts CorePro in the background at login, for the clipboard
# history (Settings → Clipboard → Run in the background does the same). It removes the old
# SliderPro launcher, binary and icons.
#
#   scripts/install-linux.sh               build, then install
#   scripts/install-linux.sh --no-build    install the existing release build
#   scripts/install-linux.sh --background  also start CorePro in the background at login
#   scripts/install-linux.sh --uninstall   remove everything this script installed
set -euo pipefail
cd "$(dirname "$0")/.."

bin_dir="$HOME/.local/bin"
lib_dir="$HOME/.local/lib/CorePro"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
desktop_file="$data_dir/applications/corepro.desktop"
autostart_file="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/corepro.desktop"
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

# SliderPro was CorePro's predecessor; its settings and caches are left alone (CorePro migrates them).
remove_sliderpro() {
  rm -f "$bin_dir/sliderpro" "$data_dir/applications/sliderpro.desktop"
  rm -rf "$HOME/.local/lib/SliderPro"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/sliderpro.png"; done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$bin_dir/corepro" "$desktop_file" "$autostart_file"
  rm -rf "$lib_dir"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/corepro.png"; done
  remove_sliderpro
  refresh_menus
  echo "CorePro removed. Settings and caches remain in ~/.config/dev.soab.corepro and ~/.cache/dev.soab.corepro."
  exit 0
fi

if [[ $build == 1 ]]; then
  npx tauri build --no-bundle
fi

install -Dm755 src-tauri/target/release/corepro "$bin_dir/corepro"
install -d "$lib_dir/resources/music"
install -m644 src-tauri/resources/music/* "$lib_dir/resources/music/"

icon_source() {
  case "$1" in
    256) echo src-tauri/icons/128x128@2x.png ;;
    512) echo src-tauri/icons/icon.png ;;
    *) echo "src-tauri/icons/${1}x${1}.png" ;;
  esac
}
for size in "${icon_sizes[@]}"; do
  install -Dm644 "$(icon_source "$size")" "$data_dir/icons/hicolor/${size}x${size}/apps/corepro.png"
done

mkdir -p "$(dirname "$desktop_file")"
cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=CorePro
GenericName=Files, photos, video and office
Comment=Files, photos, video, notes, time tracking, a wallet, Word and Excel files, and clipboard history in one app
Exec=$bin_dir/corepro %F
Icon=corepro
Terminal=false
Categories=Utility;FileManager;Graphics;AudioVideo;
Keywords=files;folders;photo;picture;gallery;slideshow;video;viewer;notes;sticky;time;tracker;wallet;money;office;word;excel;docx;xlsx;spreadsheet;document;clipboard;emoji;
MimeType=image/jpeg;image/png;image/gif;image/webp;image/bmp;image/tiff;video/mp4;video/x-matroska;video/webm;video/quicktime;video/x-msvideo;inode/directory;application/vnd.openxmlformats-officedocument.wordprocessingml.document;application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;application/vnd.ms-excel.sheet.macroEnabled.12;text/csv;text/tab-separated-values;application/pdf;
StartupWMClass=corepro
Actions=new-note;clipboard;

[Desktop Action new-note]
Name=New Note
Exec=$bin_dir/corepro --new-note

[Desktop Action clipboard]
Name=Clipboard History
Exec=$bin_dir/corepro --clipboard
EOF

# At login, CorePro starts with no window and keeps the clipboard history (the same entry
# Settings → Clipboard → "Run in the background" writes).
if [[ $background == 1 ]]; then
  mkdir -p "$(dirname "$autostart_file")"
  cat > "$autostart_file" <<EOF
[Desktop Entry]
Type=Application
Name=CorePro
Comment=Keeps the clipboard history, quick notes and the time tracker ready
Exec=$bin_dir/corepro --background
Icon=corepro
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
fi

remove_sliderpro
refresh_menus
echo "CorePro installed. Find it in your applications menu, or run: corepro"
if [[ $background == 1 ]]; then
  echo "It starts in the background at login (Settings → Clipboard → Run in the background turns that off)."
else
  echo "For clipboard history from login, turn on Settings → Clipboard → Run in the background."
fi
