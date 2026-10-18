#!/usr/bin/env bash
# Installs CorePro for the current user, no root needed: the app in ~/.local/bin, its bundled
# soundtracks in ~/.local/lib/CorePro, and a launcher entry plus icons so it appears in the
# applications menu and in "Open With" for images, video and folders. It also removes the old
# SliderPro launcher, binary and icons so the menu has no duplicate.
#
#   scripts/install-linux.sh              build, then install
#   scripts/install-linux.sh --no-build   install the existing release build
#   scripts/install-linux.sh --uninstall  remove everything this script installed
set -euo pipefail
cd "$(dirname "$0")/.."

bin_dir="$HOME/.local/bin"
lib_dir="$HOME/.local/lib/CorePro"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
desktop_file="$data_dir/applications/corepro.desktop"
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
  rm -f "$bin_dir/corepro" "$desktop_file"
  rm -rf "$lib_dir"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/corepro.png"; done
  remove_sliderpro
  refresh_menus
  echo "CorePro removed. Settings and caches remain in ~/.config/dev.soab.corepro and ~/.cache/dev.soab.corepro."
  exit 0
fi

if [[ "${1:-}" != "--no-build" ]]; then
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
GenericName=Files, photos and video
Comment=Browse files, view photos with deep zoom and play videos in one app
Exec=$bin_dir/corepro %F
Icon=corepro
Terminal=false
Categories=Utility;FileManager;Graphics;AudioVideo;
Keywords=files;folders;photo;picture;gallery;slideshow;video;viewer;
MimeType=image/jpeg;image/png;image/gif;image/webp;image/bmp;image/tiff;video/mp4;video/x-matroska;video/webm;video/quicktime;video/x-msvideo;inode/directory;
StartupWMClass=corepro
EOF

remove_sliderpro
refresh_menus
echo "CorePro installed. Find it in your applications menu, or run: corepro"
