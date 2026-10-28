#!/bin/sh
# Installs Zazabor for you (no root needed), the way scripts/install-linux.sh does: the program in
# ~/.local/bin, its sound effects in ~/.local/lib/Zazabor, and an applications-menu entry with
# icons. Zazabor then keeps itself up to date.
#
#   curl -fsSL https://soab42.github.io/zazabor-content/install.sh | sh
#
# It reads the latest release's manifest from GitHub, checks the manifest's signature against
# Zazabor's release key (with OpenSSL 3, when it's there), and installs the archive only if its
# SHA-256 matches the manifest.
set -eu

repo="Soab42/zazabor"
site="https://soab42.github.io/zazabor-content"
latest="https://github.com/$repo/releases/latest/download"
downloads="https://github.com/$repo/releases/download/"
bin_dir="$HOME/.local/bin"
lib_dir="$HOME/.local/lib/Zazabor"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'Zazabor: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail "Zazabor runs on Linux (x86-64) for now."
command -v python3 >/dev/null || fail "the installer needs python3."
command -v sha256sum >/dev/null || fail "the installer needs sha256sum (coreutils)."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
get() {
  if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null; then wget -qO "$2" "$1"
  else fail "the installer needs curl or wget."; fi
}

say "Looking for the latest Zazabor…"
get "$latest/latest.json" "$tmp/latest.json" || fail "couldn't read the latest release from GitHub."
get "$latest/latest.json.sig" "$tmp/latest.json.sig" || fail "the latest release has no signature."

# Zazabor's release key (the public half of the one that signs every release).
cat > "$tmp/key.pem" <<'KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALTY9o6vjyaypZpE/uKJNHIYvG/37VnmVPTSDNutZTjc=
-----END PUBLIC KEY-----
KEY
# The checksum below comes from this manifest, so without the signature nothing is proven: the
# install stops unless the signature checks out (OpenSSL 3, or Python's cryptography package).
# ZAZABOR_INSECURE=1 installs without checking it, on purpose only.
if command -v openssl >/dev/null && openssl version | grep -q '^OpenSSL [3-9]'; then
  python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(open(sys.argv[1]).read().strip()))' "$tmp/latest.json.sig" > "$tmp/sig.bin"
  openssl pkeyutl -verify -pubin -inkey "$tmp/key.pem" -rawin -in "$tmp/latest.json" -sigfile "$tmp/sig.bin" >/dev/null 2>&1 \
    || fail "the release isn't signed by Zazabor's key, so nothing was installed."
  say "Release signature checked."
else
  # 0: signed by Zazabor's key; 1: not; 2: no cryptography package to check with.
  if python3 - "$tmp/latest.json" "$tmp/latest.json.sig" <<'PY'; then status=0; else status=$?; fi
import base64, sys
try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
except ImportError:
    sys.exit(2)
key = Ed25519PublicKey.from_public_bytes(base64.b64decode("LTY9o6vjyaypZpE/uKJNHIYvG/37VnmVPTSDNutZTjc="))
try:
    key.verify(base64.b64decode(open(sys.argv[2]).read().strip()), open(sys.argv[1], "rb").read())
except (InvalidSignature, ValueError):
    sys.exit(1)
PY
  case "$status" in
    0) say "Release signature checked." ;;
    2) if [ "${ZAZABOR_INSECURE:-}" = 1 ]; then
         printf 'ZAZABOR_INSECURE=1: installing without checking the release'"'"'s signature.\n'
       else
         fail "can't check the release's signature here: install OpenSSL 3 (or Python's cryptography package) and try again."
       fi ;;
    *) fail "the release isn't signed by Zazabor's key, so nothing was installed." ;;
  esac
fi

# version, url, sha256 of the Linux build
set -- $(python3 - "$tmp/latest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
b = m["builds"]["linux-x86_64"]
print(m["version"], b["url"], b["sha256"])
PY
)
version="$1" url="$2" sha="$3"
case "$url" in "$downloads"*) ;; *) fail "the release points somewhere unexpected ($url)." ;; esac

say "Downloading Zazabor $version…"
get "$url" "$tmp/zazabor.tar.gz" || fail "the download failed."
[ "$(sha256sum "$tmp/zazabor.tar.gz" | cut -d' ' -f1)" = "$sha" ] || fail "the download didn't match the release's checksum."
mkdir "$tmp/unpacked"
tar xzf "$tmp/zazabor.tar.gz" -C "$tmp/unpacked" zazabor resources

say "Installing…"
install -Dm755 "$tmp/unpacked/zazabor" "$bin_dir/.zazabor.new"
mv -f "$bin_dir/.zazabor.new" "$bin_dir/zazabor"
mkdir -p "$lib_dir/resources/sfx"
cp "$tmp/unpacked/resources/sfx/"* "$lib_dir/resources/sfx/"
for size in 32 64 128 256 512; do
  mkdir -p "$data_dir/icons/hicolor/${size}x${size}/apps"
  get "$site/icons/zazabor-$size.png" "$tmp/icon.png" 2>/dev/null && mv -f "$tmp/icon.png" "$data_dir/icons/hicolor/${size}x${size}/apps/zazabor.png" || true
done
mkdir -p "$data_dir/applications"
cat > "$data_dir/applications/zazabor.desktop" <<EOF
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
update-desktop-database -q "$data_dir/applications" 2>/dev/null || true
gtk-update-icon-cache -q -t "$data_dir/icons/hicolor" 2>/dev/null || true

missing=""
for lib in libwebkit2gtk-4.1.so.0 libgstreamer-1.0.so.0 libvlc.so.5; do
  ldconfig -p 2>/dev/null | grep -q "$lib" || missing="$missing $lib"
done
say "Zazabor $version is installed. Find it in your applications menu, or run: zazabor"
if [ -n "$missing" ]; then
  printf 'It needs a few system libraries that aren'"'"'t here:%s\nOn Ubuntu, Pop!_OS or Debian: sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-good gstreamer1.0-libav vlc\n' "$missing"
fi
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to your PATH to run it from a terminal.\n' "$bin_dir" ;; esac
