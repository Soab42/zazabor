#!/usr/bin/env bash
# Publishes the content library (motion templates, soundtracks, sound effects and fonts): builds
# content-dist/ (tools/content/build.mjs, signed with the release key) and pushes it to the
# Soab42/zazabor-content repository, whose GitHub Pages serve it at
# https://soab42.github.io/zazabor-content (src-tauri/src/content.rs). Running copies of Zazabor
# pick it up within the hour, or at once with Settings → Zazabor → Library → Check Now.
#
#   tools/content/publish.sh           build and publish
#   tools/content/publish.sh --setup   the first time: create the repository and turn on its Pages
set -euo pipefail
cd "$(dirname "$0")/../.."

repo=Soab42/zazabor-content
checkout="${ZAZABOR_CONTENT_CHECKOUT:-$HOME/.cache/zazabor-content}"

node tools/content/build.mjs --out content-dist

if [[ "${1:-}" == "--setup" ]]; then
  if ! gh repo view "$repo" >/dev/null 2>&1; then
    gh repo create "$repo" --public --description "Zazabor's content library: motion templates, soundtracks, sound effects and fonts, downloaded by the app when they're used."
  fi
fi

if [[ ! -d "$checkout/.git" ]]; then
  rm -rf "$checkout"
  git clone "https://github.com/$repo.git" "$checkout"
fi
git -C "$checkout" pull --ff-only 2>/dev/null || true
rsync -a --delete --exclude .git content-dist/ "$checkout/"
git -C "$checkout" add -A
if git -C "$checkout" diff --cached --quiet; then
  echo "The library is unchanged."
else
  git -C "$checkout" commit -q -m "Library $(date -u +%Y-%m-%dT%H:%MZ)"
  git -C "$checkout" branch -M main
  git -C "$checkout" push -q -u origin main
  echo "Published to https://github.com/$repo"
fi

if [[ "${1:-}" == "--setup" ]]; then
  # GitHub Pages from the main branch's root (once; it says so if it's on already).
  gh api -X POST "repos/$repo/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
    && echo "GitHub Pages turned on: https://soab42.github.io/zazabor-content (the first build takes a minute)" \
    || echo "GitHub Pages was on already (or couldn't be turned on: check the repository's Settings → Pages)."
fi
