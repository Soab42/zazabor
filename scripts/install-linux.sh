#!/usr/bin/env bash
# Installs SliderPro for the current user, no root needed: the app in ~/.local/bin, its bundled
# soundtracks in ~/.local/lib/SliderPro, and a launcher entry plus icons so it appears in the
# applications menu and in "Open With" for images.
#
#   scripts/install-linux.sh              build, then install
#   scripts/install-linux.sh --no-build   install the existing release build
#   scripts/install-linux.sh --uninstall  remove everything this script installed
set -euo pipefail
cd "$(dirname "$0")/.."

bin_dir="$HOME/.local/bin"
lib_dir="$HOME/.local/lib/SliderPro"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
desktop_file="$data_dir/applications/sliderpro.desktop"
icon_sizes=(32 64 128 256 512)

refresh_menus() {
  update-desktop-database -q "$data_dir/applications" 2>/dev/null || true
  gtk-update-icon-cache -q -t "$data_dir/icons/hicolor" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$bin_dir/sliderpro" "$desktop_file"
  rm -rf "$lib_dir"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/sliderpro.png"; done
  refresh_menus
  echo "SliderPro removed. Settings and caches remain in ~/.config/dev.soab.sliderpro and ~/.cache/dev.soab.sliderpro."
  exit 0
fi

if [[ "${1:-}" != "--no-build" ]]; then
  npx tauri build --no-bundle
fi

install -Dm755 src-tauri/target/release/sliderpro "$bin_dir/sliderpro"
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
  install -Dm644 "$(icon_source "$size")" "$data_dir/icons/hicolor/${size}x${size}/apps/sliderpro.png"
done

mkdir -p "$(dirname "$desktop_file")"
cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=SliderPro
GenericName=Photo Gallery
Comment=Browse your photos with deep zoom and play cinematic slideshows
Exec=$bin_dir/sliderpro %F
Icon=sliderpro
Terminal=false
Categories=Graphics;Photography;Viewer;
Keywords=photo;picture;gallery;slideshow;viewer;album;
MimeType=image/jpeg;image/png;image/gif;image/webp;image/bmp;image/tiff;
StartupWMClass=sliderpro
EOF

refresh_menus
echo "SliderPro installed. Find it in your applications menu, or run: sliderpro"
