#!/usr/bin/env python3
"""Fetches the Motion templates' fonts (SIL Open Font License) from github.com/google/fonts at a
pinned commit into public/fonts/, checking each file's SHA-256 against fonts.lock.json when it
exists (and writing it when it doesn't). Run: python3 tools/fetch_motion_fonts.py"""
import hashlib, json, os, sys, urllib.parse, urllib.request

COMMIT = "bd8f81ddb5c74d5c8897b36ad88b440266245103"  # google/fonts main, 2026-10-09
FILES = {
    "inter": ["Inter[opsz,wght].ttf"],
    "poppins": ["Poppins-Regular.ttf", "Poppins-SemiBold.ttf", "Poppins-Bold.ttf", "Poppins-ExtraBold.ttf"],
    "montserrat": ["Montserrat[wght].ttf"],
    "plusjakartasans": ["PlusJakartaSans[wght].ttf"],
    "dmsans": ["DMSans[opsz,wght].ttf"],
    "manrope": ["Manrope[wght].ttf"],
    "spacegrotesk": ["SpaceGrotesk[wght].ttf"],
    "outfit": ["Outfit[wght].ttf"],
    "sora": ["Sora[wght].ttf"],
    "bebasneue": ["BebasNeue-Regular.ttf"],
    "anton": ["Anton-Regular.ttf"],
    "oswald": ["Oswald[wght].ttf"],
    "archivoblack": ["ArchivoBlack-Regular.ttf"],
    "syne": ["Syne[wght].ttf"],
    "unbounded": ["Unbounded[wght].ttf"],
    "righteous": ["Righteous-Regular.ttf"],
    "playfairdisplay": ["PlayfairDisplay[wght].ttf", "PlayfairDisplay-Italic[wght].ttf"],
    "dmserifdisplay": ["DMSerifDisplay-Regular.ttf", "DMSerifDisplay-Italic.ttf"],
    "fraunces": ["Fraunces[SOFT,WONK,opsz,wght].ttf"],
    "cormorantgaramond": ["CormorantGaramond[wght].ttf"],
    "pacifico": ["Pacifico-Regular.ttf"],
    "caveat": ["Caveat[wght].ttf"],
    "dancingscript": ["DancingScript[wght].ttf"],
    "hindsiliguri": ["HindSiliguri-Regular.ttf", "HindSiliguri-SemiBold.ttf", "HindSiliguri-Bold.ttf"],
    "anekbangla": ["AnekBangla[wdth,wght].ttf"],
    "balooda2": ["BalooDa2[wght].ttf"],
    "tirobangla": ["TiroBangla-Regular.ttf"],
    "galada": ["Galada-Regular.ttf"],
}
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "fonts")
LOCK = os.path.join(ROOT, "fonts.lock.json")

def get(path: str) -> bytes:
    url = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/" + urllib.parse.quote(path)
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()

def main() -> int:
    lock = json.load(open(LOCK)) if os.path.exists(LOCK) else None
    out = {"commit": COMMIT, "files": {}}
    for family, names in FILES.items():
        os.makedirs(os.path.join(ROOT, family), exist_ok=True)
        for name in names + ["OFL.txt"]:
            rel = f"{family}/{name}"
            data = get(f"ofl/{family}/{name}")
            digest = hashlib.sha256(data).hexdigest()
            if lock and lock["files"].get(rel) != digest:
                print(f"{rel}: checksum differs from fonts.lock.json", file=sys.stderr)
                return 1
            with open(os.path.join(ROOT, rel), "wb") as f:
                f.write(data)
            out["files"][rel] = digest
    if not lock:
        with open(LOCK, "w") as f:
            json.dump(out, f, indent=1, sort_keys=True)
    print(f"{len(out['files'])} files in public/fonts")
    return 0

if __name__ == "__main__":
    sys.exit(main())
