export const TRANSITION_GROUPS = [
  { label: "Classic", items: [["dissolve", "Dissolve"], ["dip", "Dip to black"], ["fadewhite", "Fade to white"], ["wipe", "Soft wipe"], ["iris", "Iris"], ["clock", "Clock wipe"]] },
  { label: "Light", items: [["leak", "Light leak"], ["sweep", "Light sweep"], ["flash", "Flash"], ["bokeh", "Bokeh"], ["burn", "Film burn"], ["luma", "Luma fade"]] },
  { label: "Motion", items: [["push", "Push through"], ["slide", "Parallax slide"], ["whip", "Whip pan"], ["drop", "Drop & bounce"], ["cards", "Card stack"]] },
  { label: "Zoom & spin", items: [["zoom", "Cross zoom"], ["punch", "Zoom punch"], ["zoomspin", "Zoom spin"], ["spin", "Spin blur"], ["hyperspace", "Hyperspace"], ["bulge", "Lens bulge"]] },
  { label: "3D", items: [["cube", "Cube"], ["flip", "Card flip"], ["doors", "Doors"], ["fold", "Accordion fold"], ["tiles", "Flip tiles"]] },
  { label: "Liquid & organic", items: [["liquid", "Liquid melt"], ["ripple", "Ripple"], ["swirl", "Swirl"], ["morph", "Morph"], ["wave", "Wave wipe"], ["ink", "Ink bloom"], ["smoke", "Smoke"], ["dust", "Disintegrate"], ["blur", "Blur dissolve"]] },
  { label: "Geometric", items: [["shutter", "Shutter"], ["slices", "Slices"], ["hexagon", "Hexagons"], ["dots", "Dots"], ["halftone", "Halftone"], ["shatter", "Glass shatter"], ["kaleido", "Kaleidoscope"]] },
  { label: "Digital", items: [["glitch", "Glitch"], ["pixelate", "Pixelate"], ["chromatic", "Chromatic"], ["datamosh", "Datamosh"], ["vhs", "VHS"], ["neon", "Neon edges"]] },
] as const;

type GroupItem = (typeof TRANSITION_GROUPS)[number]["items"][number];
export type TransitionKind = GroupItem[0];
/** "custom" draws from the user's own mix (`customTransitions`). */
export type TransitionChoice = "theme" | "random" | "custom" | TransitionKind;

export const TRANSITIONS: { id: TransitionChoice; label: string }[] = [
  { id: "theme", label: "Match theme" },
  { id: "random", label: "Surprise me (all)" },
  { id: "custom", label: "My mix" },
  ...TRANSITION_GROUPS.flatMap((g) => g.items.map(([id, label]) => ({ id, label }))),
];

export const transitionLabel = (id: TransitionChoice) => TRANSITIONS.find((t) => t.id === id)?.label ?? id;

/** Shader ids, in the order the GLSL expects. */
export const TRANSITION_IDS: Record<TransitionKind, number> = {
  dissolve: 0, dip: 1, blur: 2, leak: 3, zoom: 4, push: 5, wipe: 6, whip: 7,
  flash: 8, glitch: 9, punch: 10, spin: 11, shutter: 12, ripple: 13, burn: 14, luma: 15,
  fadewhite: 16, sweep: 17, bokeh: 18, slide: 19, drop: 20, zoomspin: 21, hyperspace: 22, cube: 23,
  flip: 24, fold: 25, doors: 26, tiles: 27, cards: 28, liquid: 29, swirl: 30, morph: 31,
  wave: 32, kaleido: 33, bulge: 34, pixelate: 35, chromatic: 36, datamosh: 37, vhs: 38, neon: 39,
  halftone: 40, hexagon: 41, dots: 42, iris: 43, clock: 44, slices: 45, shatter: 46, ink: 47,
  smoke: 48, dust: 49,
};

const ALL_KINDS = Object.keys(TRANSITION_IDS) as TransitionKind[];

export const LOOKS = [
  { id: "natural", label: "Natural" },
  { id: "film", label: "Film" },
  { id: "tealorange", label: "Teal & orange" },
  { id: "golden", label: "Golden hour" },
  { id: "faded", label: "Faded memory" },
  { id: "noir", label: "Noir" },
] as const;

export type LookId = (typeof LOOKS)[number]["id"];

export interface Grade {
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  saturation: number;
  contrast: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
}

const neutral: Grade = {
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  saturation: 1, contrast: 0, shadowTint: [0, 0, 0], highlightTint: [0, 0, 0],
};

export const GRADES: Record<LookId, Grade> = {
  natural: { ...neutral, contrast: 0.08, saturation: 1.04 },
  film: {
    lift: [0.025, 0.02, 0.03], gamma: [1.0, 1.0, 0.98], gain: [1.0, 0.98, 0.94],
    saturation: 0.9, contrast: 0.32, shadowTint: [-0.01, 0.005, 0.02], highlightTint: [0.025, 0.012, -0.01],
  },
  tealorange: {
    lift: [0, 0.01, 0.02], gamma: [1.02, 1, 0.98], gain: [1.03, 1.0, 0.95],
    saturation: 1.08, contrast: 0.3, shadowTint: [-0.035, 0.012, 0.04], highlightTint: [0.045, 0.012, -0.035],
  },
  golden: {
    lift: [0.02, 0.012, 0], gamma: [1.06, 1.02, 0.94], gain: [1.05, 1.0, 0.88],
    saturation: 1.05, contrast: 0.18, shadowTint: [0.01, 0.0, -0.01], highlightTint: [0.04, 0.02, -0.02],
  },
  faded: {
    lift: [0.07, 0.065, 0.07], gamma: [1.02, 1.0, 1.0], gain: [0.96, 0.95, 0.92],
    saturation: 0.72, contrast: 0.05, shadowTint: [0.0, 0.01, 0.02], highlightTint: [0.02, 0.012, 0.0],
  },
  noir: {
    lift: [0.01, 0.01, 0.01], gamma: [0.98, 0.98, 0.98], gain: [1.04, 1.04, 1.04],
    saturation: 0, contrast: 0.45, shadowTint: [0, 0, 0], highlightTint: [0, 0, 0],
  },
};

export type Framing = "smart" | "fill" | "fit";

/** Music setting values for the soundtracks bundled with the app look like "builtin:action". */
export const BUILTIN_MUSIC = "builtin:";

export interface SlideshowSettings {
  theme: ThemeId;
  /** Seconds each photo stays fully on screen. */
  duration: number;
  /** Transition length in seconds. */
  transitionTime: number;
  transition: TransitionChoice;
  /** The user's own transition mix, used by the Custom style and "My mix". */
  customTransitions: TransitionKind[];
  /** 0 disables Ken Burns motion; 1 is the strongest. */
  kenBurns: number;
  framing: Framing;
  look: LookId;
  grain: number;
  vignette: number;
  letterbox: boolean;
  captions: boolean;
  titleCard: boolean;
  shuffle: boolean;
  loop: boolean;
  /** A file path, a built-in track ("builtin:<id>"), or null for silence. */
  music: string | null;
  musicVolume: number;
  /** With a built-in track, start transitions so they land on the beat. */
  beatSync: boolean;
}

type ThemeLook = Pick<SlideshowSettings, "duration" | "transitionTime" | "kenBurns" | "look" | "grain" | "vignette" | "letterbox">;

export interface Theme {
  id: string;
  label: string;
  blurb: string;
  /** Built-in soundtrack id. */
  track: string;
  /** Weighted transition pool used by "Match theme". */
  transitions: [TransitionKind, number][];
  /** Cuts snap to every n-th beat of the soundtrack. */
  beatsPerCut: number;
  look: ThemeLook;
}

export const THEMES = [
  {
    id: "cinematic", label: "Cinematic", blurb: "Graceful dissolves, light sweeps and a widescreen frame",
    track: "cinematic", beatsPerCut: 2,
    transitions: [["dissolve", 24], ["blur", 14], ["leak", 12], ["sweep", 10], ["dip", 8], ["luma", 8], ["push", 8], ["smoke", 6], ["iris", 5], ["zoom", 5]],
    look: { duration: 5.5, transitionTime: 1.8, kenBurns: 0.55, look: "film", grain: 0.3, vignette: 0.35, letterbox: true },
  },
  {
    id: "modern", label: "Modern", blurb: "Sleek 2026 motion: parallax slides, 3D cubes, liquid and chromatic zooms",
    track: "house", beatsPerCut: 2,
    transitions: [["slide", 14], ["cube", 12], ["liquid", 12], ["chromatic", 10], ["zoomspin", 10], ["cards", 10], ["sweep", 8], ["morph", 8], ["hexagon", 8], ["iris", 8]],
    look: { duration: 3.4, transitionTime: 1.0, kenBurns: 0.65, look: "natural", grain: 0.08, vignette: 0.2, letterbox: false },
  },
  {
    id: "action", label: "Action", blurb: "Fast cuts on the beat: whip pans, punches, flashes and hyperspace",
    track: "action", beatsPerCut: 1,
    transitions: [["whip", 14], ["punch", 14], ["flash", 12], ["glitch", 10], ["hyperspace", 10], ["chromatic", 10], ["zoom", 8], ["slide", 8], ["shutter", 7]],
    look: { duration: 2.2, transitionTime: 0.5, kenBurns: 0.95, look: "tealorange", grain: 0.2, vignette: 0.4, letterbox: true },
  },
  {
    id: "neon", label: "Neon", blurb: "Glitches, VHS, datamosh and glowing neon edges",
    track: "synthwave", beatsPerCut: 1,
    transitions: [["neon", 16], ["glitch", 16], ["vhs", 14], ["datamosh", 14], ["pixelate", 12], ["chromatic", 12], ["hyperspace", 8], ["flash", 8]],
    look: { duration: 2.6, transitionTime: 0.7, kenBurns: 0.8, look: "tealorange", grain: 0.25, vignette: 0.5, letterbox: false },
  },
  {
    id: "adventure", label: "Adventure", blurb: "Sweeping pushes, spins and light leaks with a heroic score",
    track: "adventure", beatsPerCut: 2,
    transitions: [["push", 14], ["leak", 12], ["spin", 10], ["zoomspin", 10], ["sweep", 10], ["whip", 10], ["doors", 8], ["burn", 8], ["zoom", 8], ["cube", 6]],
    look: { duration: 3.6, transitionTime: 1.1, kenBurns: 0.8, look: "golden", grain: 0.22, vignette: 0.32, letterbox: true },
  },
  {
    id: "travel", label: "Travel", blurb: "Postcard energy: cubes, flips, doors and parallax slides",
    track: "acoustic", beatsPerCut: 2,
    transitions: [["cube", 14], ["flip", 12], ["doors", 12], ["slide", 12], ["cards", 10], ["fold", 10], ["tiles", 10], ["push", 10], ["sweep", 8]],
    look: { duration: 3.8, transitionTime: 1.2, kenBurns: 0.7, look: "natural", grain: 0.1, vignette: 0.25, letterbox: false },
  },
  {
    id: "dreamy", label: "Dreamy", blurb: "Soft blurs, liquid ripples, bokeh and smoke",
    track: "dreamy", beatsPerCut: 2,
    transitions: [["blur", 16], ["ripple", 14], ["liquid", 14], ["bokeh", 14], ["smoke", 12], ["luma", 10], ["swirl", 8], ["leak", 8], ["fadewhite", 6]],
    look: { duration: 6, transitionTime: 2.6, kenBurns: 0.4, look: "faded", grain: 0.15, vignette: 0.25, letterbox: false },
  },
  {
    id: "elegant", label: "Elegant", blurb: "Weddings and portraits: fades to white, bokeh, iris and ink",
    track: "memories", beatsPerCut: 2,
    transitions: [["fadewhite", 18], ["bokeh", 16], ["iris", 14], ["ink", 12], ["luma", 12], ["dissolve", 12], ["smoke", 8], ["sweep", 8]],
    look: { duration: 5.5, transitionTime: 2.0, kenBurns: 0.45, look: "golden", grain: 0.12, vignette: 0.3, letterbox: false },
  },
  {
    id: "memories", label: "Memories", blurb: "Warm, nostalgic film burns and fades with a gentle piano",
    track: "memories", beatsPerCut: 2,
    transitions: [["dissolve", 24], ["leak", 18], ["burn", 14], ["luma", 12], ["dip", 12], ["ink", 10], ["fadewhite", 10]],
    look: { duration: 5, transitionTime: 1.6, kenBurns: 0.45, look: "golden", grain: 0.4, vignette: 0.45, letterbox: false },
  },
  {
    id: "playful", label: "Playful", blurb: "Bouncy drops, dots, tiles, halftones and kaleidoscopes",
    track: "acoustic", beatsPerCut: 2,
    transitions: [["drop", 14], ["dots", 14], ["tiles", 12], ["halftone", 12], ["kaleido", 10], ["bulge", 10], ["swirl", 10], ["cards", 10], ["clock", 8]],
    look: { duration: 3, transitionTime: 0.9, kenBurns: 0.7, look: "natural", grain: 0.05, vignette: 0.15, letterbox: false },
  },
  {
    id: "custom", label: "Custom", blurb: "Your own style: keeps your timing, look and music, with your own mix of transitions",
    track: "cinematic", beatsPerCut: 2,
    transitions: [],
    look: { duration: 4.5, transitionTime: 1.4, kenBurns: 0.55, look: "natural", grain: 0.1, vignette: 0.25, letterbox: false },
  },
  {
    id: "noir", label: "Noir", blurb: "Black and white, moody: ink, slices and slow fades",
    track: "jazz", beatsPerCut: 2,
    transitions: [["dip", 22], ["dissolve", 20], ["luma", 16], ["ink", 14], ["slices", 10], ["shutter", 10], ["clock", 8]],
    look: { duration: 5, transitionTime: 1.6, kenBurns: 0.5, look: "noir", grain: 0.45, vignette: 0.55, letterbox: true },
  },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const themeOf = (id: ThemeId): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0];

/** The transitions a show draws from, weighted: the user's own mix, or the theme's. */
export function transitionPool(settings: SlideshowSettings): ReadonlyArray<readonly [TransitionKind, number]> {
  if (settings.transition === "custom" || settings.theme === "custom") {
    return settings.customTransitions.length ? settings.customTransitions.map((kind) => [kind, 1] as const) : [["dissolve", 1]];
  }
  return themeOf(settings.theme).transitions;
}

/** Switches to the user's own mix, starting it from whatever was playing if it is empty. */
export function useCustomMix(settings: SlideshowSettings) {
  if (!settings.customTransitions.length) {
    const choice = settings.transition;
    settings.customTransitions = choice === "random" ? [...ALL_KINDS]
      : choice === "theme" || choice === "custom" ? transitionPool(settings).map(([kind]) => kind)
      : [choice];
  }
  settings.transition = "custom";
}

/**
 * Applies a theme's pacing, look, transitions and soundtrack (keeping a user's own music file).
 * The Custom style keeps whatever the user has set and plays their own mix.
 */
export function applyTheme(settings: SlideshowSettings, id: ThemeId) {
  if (id === "custom") {
    useCustomMix(settings);
    settings.theme = id;
    return;
  }
  const theme = themeOf(id);
  settings.theme = id;
  Object.assign(settings, theme.look);
  settings.transition = "theme";
  if (!settings.music || settings.music.startsWith(BUILTIN_MUSIC)) settings.music = `${BUILTIN_MUSIC}${theme.track}`;
}

export function pickTransition(settings: SlideshowSettings, previous: TransitionKind | null, random: () => number): TransitionKind {
  if (settings.transition === "random") {
    const pool = ALL_KINDS.filter((k) => k !== previous);
    return pool[Math.floor(random() * pool.length)];
  }
  if (settings.transition !== "theme" && settings.transition !== "custom") return settings.transition;
  // Never repeat a transition back to back unless it is a plain dissolve (or the only one).
  const full = transitionPool(settings);
  const fresh = full.filter(([kind]) => kind === "dissolve" || kind !== previous);
  const pool = fresh.length ? fresh : full;
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [kind, weight] of pool) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return pool[0]?.[0] ?? "dissolve";
}

function defaults(): SlideshowSettings {
  const settings: SlideshowSettings = {
    theme: "cinematic", duration: 5, transitionTime: 1.6, transition: "theme", customTransitions: [], kenBurns: 0.55, framing: "smart",
    look: "film", grain: 0.3, vignette: 0.35, letterbox: true, captions: false, titleCard: true,
    shuffle: false, loop: true, music: null, musicVolume: 0.8, beatSync: true,
  };
  applyTheme(settings, "cinematic");
  return settings;
}

/** Fills in missing or invalid fields, e.g. from an older saved config. */
export function normalizeSettings(raw: Partial<SlideshowSettings> | undefined): SlideshowSettings {
  // Configs from before themes existed start over from the default theme.
  if (!raw?.theme) return defaults();
  const s = { ...defaults(), ...raw };
  if (!THEMES.some((t) => t.id === s.theme)) s.theme = "cinematic";
  if (!TRANSITIONS.some((t) => t.id === s.transition)) s.transition = "theme";
  s.customTransitions = Array.isArray(s.customTransitions) ? s.customTransitions.filter((k) => k in TRANSITION_IDS) : [];
  if (!LOOKS.some((l) => l.id === s.look)) s.look = "film";
  if (!["smart", "fill", "fit"].includes(s.framing)) s.framing = "smart";
  return s;
}
