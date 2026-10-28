#!/usr/bin/env bash
# Publishes a Zazabor release on GitHub, which installed copies update to (src-tauri/src/update.rs,
# Settings → Zazabor → Updates): sets the version, builds, packs the program with its sound
# effects, writes latest.json (the version, the notes, the archive's size and SHA-256) signed with
# the release key (tools/release/sign.mjs), commits and tags the version, and creates the release
# with the three files. Copies installed before 0.2.0 have no updater: install that one by hand.
#
#   scripts/release.sh 0.2.0 "What's new, in a line or two"
#   scripts/release.sh 0.2.0 --notes-file notes.txt
#   scripts/release.sh 0.2.0 "…" --dry-run    build and pack into dist-release/0.2.0, publish nothing
set -euo pipefail
cd "$(dirname "$0")/.."

repo=Soab42/zazabor
platform=linux-x86_64
version="${1:-}"
shift || true
notes=""
dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes-file) notes="$(cat "$2")"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) notes="$1"; shift ;;
  esac
done
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/release.sh <version, like 0.2.0> \"notes\" [--dry-run]" >&2
  exit 2
fi
current="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
if [[ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)" != "$version" || "$current" == "$version" ]]; then
  echo "The new version ($version) must be later than the current one ($current)." >&2
  exit 2
fi
node tools/release/sign.mjs public >/dev/null  # fails here, before building, without the key
if [[ $dry_run == 0 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Commit or stash your changes first: a release is built from what's committed." >&2
    exit 1
  fi
  gh auth status >/dev/null
fi

# The version, in the three places that have it. A dry run (or a failed build) puts them back as
# they were, from copies (not from git, which would lose uncommitted work).
versioned=(package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock)
saved="$(mktemp -d)"
for f in "${versioned[@]}"; do cp "$f" "$saved/$(basename "$f")"; done
restore_versions() {
  for f in "${versioned[@]}"; do cp "$saved/$(basename "$f")" "$f"; done
}
trap 'restore_versions; rm -rf "$saved"' EXIT
node - "$version" <<'JS'
const fs = require("fs");
const v = process.argv[2];
for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = v;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}
const toml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
fs.writeFileSync("src-tauri/Cargo.toml", toml.replace(/^version = "[^"]*"/m, `version = "${v}"`));
JS

npx tauri build --no-bundle

out="dist-release/$version"
archive="zazabor-$version-$platform.tar.gz"
rm -rf "$out"
mkdir -p "$out/stage/resources"
install -m755 src-tauri/target/release/zazabor "$out/stage/zazabor"
cp -r src-tauri/resources/sfx "$out/stage/resources/sfx"
tar czf "$out/$archive" -C "$out/stage" zazabor resources
rm -rf "$out/stage"

node - "$version" "$out/$archive" "https://github.com/$repo/releases/download/v$version/$archive" "$platform" "$notes" <<'JS' > "$out/latest.json"
const fs = require("fs");
const crypto = require("crypto");
const [version, file, url, platform, notes] = process.argv.slice(2);
const data = fs.readFileSync(file);
const manifest = {
  kind: "zazabor-update",
  version,
  published: Math.floor(Date.now() / 1000),
  notes,
  builds: { [platform]: { url, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") } },
};
process.stdout.write(JSON.stringify(manifest, null, 1) + "\n");
JS
node tools/release/sign.mjs sign "$out/latest.json"
echo "Packed $out: $archive ($(du -h "$out/$archive" | cut -f1)), latest.json, latest.json.sig"

if [[ $dry_run == 1 ]]; then
  echo "Dry run: nothing was published, and the version is back to $current."
  exit 0
fi

# From here the new version stays.
trap 'rm -rf "$saved"' EXIT
git add "${versioned[@]}"
git commit -q -m "Zazabor $version"
git tag "v$version"
git push -q origin HEAD "v$version"
gh release create "v$version" "$out/$archive" "$out/latest.json" "$out/latest.json.sig" \
  --repo "$repo" --title "Zazabor $version" --notes "${notes:-Zazabor $version}" --latest
echo "Released: https://github.com/$repo/releases/tag/v$version"
