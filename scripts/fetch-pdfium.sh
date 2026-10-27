#!/usr/bin/env bash
# Fetches PDFium (BSD-3-Clause; Google's PDF engine, as Chrome uses it) for the PDF app's editing
# tools: true redaction and editing existing text. A prebuilt library from
# github.com/bblanchon/pdfium-binaries (MIT build scripts), at a pinned release, checked against
# its published SHA-256. It goes to src-tauri/pdfium/ (not in git); scripts/install-linux.sh
# installs it beside Zazabor.
#
#   scripts/fetch-pdfium.sh          fetch it if it isn't there yet
#   scripts/fetch-pdfium.sh --force  fetch it again
set -euo pipefail

RELEASE="chromium/8100"   # 2026-10-12
SHA256="1c1894a12d4d96ee01400c3874444126254180c5c7d2ab628576b67f8120320a"
URL="https://github.com/bblanchon/pdfium-binaries/releases/download/${RELEASE}/pdfium-linux-x64.tgz"

cd "$(dirname "$0")/.."
dest="src-tauri/pdfium"
lib="$dest/lib/libpdfium.so"

if [[ -f "$lib" && "${1:-}" != "--force" ]]; then
  echo "PDFium is already in $dest ($(cat "$dest/RELEASE" 2>/dev/null || echo "unknown release"))."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading PDFium ${RELEASE}…"
curl -fL --proto '=https' --tlsv1.2 -o "$tmp/pdfium.tgz" "$URL"
echo "${SHA256}  $tmp/pdfium.tgz" | sha256sum -c --quiet - || { echo "The download doesn't match the pinned checksum; nothing was installed." >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tmp/pdfium.tgz" -C "$dest" lib/libpdfium.so LICENSE VERSION 2>/dev/null || tar -xzf "$tmp/pdfium.tgz" -C "$dest"
echo "$RELEASE" > "$dest/RELEASE"
echo "PDFium ${RELEASE} is in $dest."
