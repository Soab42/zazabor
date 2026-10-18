/** Languages for the default audio / subtitle choice and finding them among VLC's track names. */

export interface Language {
  /** Two-letter code, also what OpenSubtitles takes. */
  code: string;
  name: string;
  /** Three-letter code as seen in track names. */
  iso3: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", iso3: "eng" },
  { code: "es", name: "Spanish", iso3: "spa" },
  { code: "fr", name: "French", iso3: "fre" },
  { code: "de", name: "German", iso3: "ger" },
  { code: "it", name: "Italian", iso3: "ita" },
  { code: "pt", name: "Portuguese", iso3: "por" },
  { code: "nl", name: "Dutch", iso3: "dut" },
  { code: "sv", name: "Swedish", iso3: "swe" },
  { code: "pl", name: "Polish", iso3: "pol" },
  { code: "ru", name: "Russian", iso3: "rus" },
  { code: "tr", name: "Turkish", iso3: "tur" },
  { code: "ar", name: "Arabic", iso3: "ara" },
  { code: "hi", name: "Hindi", iso3: "hin" },
  { code: "bn", name: "Bengali", iso3: "ben" },
  { code: "ja", name: "Japanese", iso3: "jpn" },
  { code: "ko", name: "Korean", iso3: "kor" },
  { code: "zh", name: "Chinese", iso3: "chi" },
];

export const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

/** The first track whose name mentions the language (by name, `[eng]`-style code or a bare code). */
export function trackForLanguage<T extends { id: number; name: string }>(tracks: T[], code: string): T | undefined {
  const lang = LANGUAGES.find((l) => l.code === code);
  if (!lang) return undefined;
  const alt = lang.iso3 === "fre" ? "fra" : lang.iso3 === "ger" ? "deu" : lang.iso3 === "chi" ? "zho" : lang.iso3 === "dut" ? "nld" : "";
  const words = [lang.name.toLowerCase(), lang.iso3, alt, lang.code].filter(Boolean);
  return tracks.find((track) => {
    const tokens = track.name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    return words.some((w) => (w.length > 2 ? tokens.includes(w) || track.name.toLowerCase().includes(w) : tokens.includes(w)));
  });
}
