#!/usr/bin/env bash
# Builds the two Android apps, Zazabor Link (mobile-cast/) and Zazabor Wallet (mobile/), signed
# with the Android release key, and attaches them to a GitHub release as zazabor-link.apk and
# zazabor-wallet.apk. The names never change, so the website's links and QR codes
# (releases/latest/download/…) always reach the newest ones; scripts/release.sh's --latest release
# needs them attached again, so run this after each release.
#
#   scripts/release-phone-apps.sh             build, and attach to the latest release
#   scripts/release-phone-apps.sh v0.2.5      attach to that release
#   scripts/release-phone-apps.sh --build     build into dist-release/phone only
#   PHONE_NOTES="What's new" scripts/release-phone-apps.sh   the same notes shown in both apps' update popup
#
# phone-apps.json, uploaded with them, is what the apps' updater reads (Updater.kt in each app):
# each app's version, version code, file, size and SHA-256. Android only installs an update signed
# with the same key as the installed copy, so the list itself needs no signature.
#
# The key: ~/.config/zazabor-release/android-release.jks, with its passwords in
# android-signing.properties next to it (ZAZABOR_ANDROID_SIGNING names another file). Back both
# up with the update key: phones only install a new version signed with the same key.
set -euo pipefail
cd "$(dirname "$0")/.."

repo=Soab42/zazabor-home
signing="${ZAZABOR_ANDROID_SIGNING:-$HOME/.config/zazabor-release/android-signing.properties}"
[[ -f "$signing" ]] || { echo "No Android signing key ($signing)." >&2; exit 1; }
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
build_tools="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"

out=dist-release/phone
mkdir -p "$out"

(cd mobile-cast && ./gradlew -q assembleRelease)
install -m644 mobile-cast/app/build/outputs/apk/release/app-release.apk "$out/zazabor-link.apk"

# arm64 covers phones from the last several years.
(cd mobile && ../node_modules/.bin/tauri android build --apk --target aarch64 --ci)
install -m644 mobile/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk "$out/zazabor-wallet.apk"

for apk in "$out"/zazabor-link.apk "$out"/zazabor-wallet.apk; do
  "$build_tools/apksigner" verify "$apk" || { echo "$apk isn't signed." >&2; exit 1; }
  echo "$(basename "$apk"): $(numfmt --to=iec --suffix=B "$(stat -c %s "$apk")"), $("$build_tools/aapt2" dump badging "$apk" | grep -o "versionName='[^']*'")"
done

entry() { # app file
  local apk="$out/$2" badging
  badging="$("$build_tools/aapt2" dump badging "$apk" | head -1)"
  node -e '
    const [app, file, bytes, sha256, badging, notes] = process.argv.slice(1);
    const version = /versionName='"'"'([^'"'"']*)'"'"'/.exec(badging)[1];
    const code = Number(/versionCode='"'"'([0-9]+)'"'"'/.exec(badging)[1]);
    process.stdout.write(JSON.stringify([app, { version, code, file, bytes: Number(bytes), sha256, notes }]));
  ' "$1" "$2" "$(stat -c %s "$apk")" "$(sha256sum "$apk" | cut -d' ' -f1)" "$badging" "${PHONE_NOTES:-}"
}
node -e '
  const apps = Object.fromEntries(process.argv.slice(1).map((e) => JSON.parse(e)));
  process.stdout.write(JSON.stringify({ kind: "zazabor-phone-apps", published: Math.floor(Date.now() / 1000), apps }, null, 1) + "\n");
' "$(entry link zazabor-link.apk)" "$(entry wallet zazabor-wallet.apk)" > "$out/phone-apps.json"
cat "$out/phone-apps.json"

[[ "${1:-}" == "--build" ]] && exit 0
tag="${1:-$(gh release view --repo "$repo" --json tagName -q .tagName)}"
gh release upload "$tag" "$out/zazabor-link.apk" "$out/zazabor-wallet.apk" "$out/phone-apps.json" --repo "$repo" --clobber
echo "Attached to https://github.com/$repo/releases/tag/$tag"
