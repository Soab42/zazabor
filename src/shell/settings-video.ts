import { open } from "../shared/dialog";
import type { SettingsGroup, SettingsRow } from "../appearance";
import { basename, h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";
import { CONVERT_PROFILES } from "../modules/video/media-api";
import { openShortcuts } from "../modules/video/features/hotkeys";
import { profilesPanel } from "../modules/video/features/profiles/ui";
import { mediaSettings, notifyMediaSettings, type MediaSettings } from "../modules/video/features/profiles/settings";
import "../modules/video/features/open/media.css";
import type { Category, SettingsHost } from "./settings";

/**
 * The Video part of the Settings page: nine categories, each with the everyday settings first and
 * an "Advanced" group below. Every setting has an info icon with one sentence of explanation, and
 * the choices are words rather than codes. Values live in `config.video.ext.media`
 * (see `features/profiles/settings.ts`); the player reads them from there.
 */

type Host = Pick<SettingsHost, "config" | "configChanged">;
type Key = keyof MediaSettings;

interface Base {
  label: string;
  /** One sentence for the info icon. */
  info: string;
}
type Field = Base &
  (
    | { kind: "toggle"; key: Key }
    | { kind: "choice"; key: Key; options: [string | number, string][]; menu?: boolean }
    | { kind: "slider"; key: Key; min: number; max: number; step: number; format: (value: number) => string }
    | { kind: "folder"; key: Key; enabled?: (s: MediaSettings) => boolean }
    | { kind: "button"; text: string; run: (button: HTMLButtonElement) => void }
    | { kind: "profiles" }
  );

interface Page {
  id: string;
  title: string;
  icon: IconName;
  /** A sentence above the groups. */
  note?: string;
  groups: { title: string; fields: Field[] }[];
}

const seconds = (n: number) => `${Number(n.toFixed(1))} second${n === 1 ? "" : "s"}`;

const PAGES: Page[] = [
  {
    id: "video", title: "Interface", icon: "palette",
    groups: [
      {
        title: "Look",
        fields: [
          { kind: "choice", key: "playerAccent", label: "Player accent", info: "Choose whether the player uses CorePro's accent colour or a warm orange of its own.", options: [["app", "Follow CorePro"], ["orange", "Orange"]] },
          { kind: "toggle", key: "glassControls", label: "Liquid Glass controls", info: "The controls float over the video as glass that bends the picture beneath, like macOS, and hide while the video plays. Off docks them in a bar below the picture." },
          { kind: "button", label: "Welcome tour", info: "Replays the short introduction the first time you open Video.", text: "Show Again", run: () => {
            mediaSettings({ config: hostRef.config }).introSeen = false;
            hostRef.configChanged();
            notifyMediaSettings(["introSeen"]);
          } },
          { kind: "button", label: "Keyboard shortcuts", info: "Opens the list of keys the player understands.", text: "Show Shortcuts…", run: () => openShortcuts(mediaSettings({ config: hostRef.config })) },
        ],
      },
      {
        title: "Profiles",
        fields: [{ kind: "profiles", label: "Saved setups", info: "A profile remembers the control bar's layout together with your video settings, so you can switch between setups." }],
      },
    ],
  },
  {
    id: "video-playback", title: "Playback", icon: "play",
    groups: [
      {
        title: "Playback",
        fields: [
          { kind: "choice", key: "resume", label: "When I open a video I've started", info: "Decide whether a video continues from where you stopped, asks you first, or always starts at the beginning.", options: [["always", "Continue"], ["ask", "Ask me"], ["never", "Start over"]] },
          { kind: "slider", key: "defaultSpeed", label: "Starting speed", info: "The speed every new video starts at; 1× is normal.", min: 0.25, max: 2, step: 0.05, format: (v) => `${Number(v.toFixed(2))}×` },
          { kind: "slider", key: "skipSeconds", label: "Jump with ← and →", info: "How far the left and right arrow keys move through a video.", min: 1, max: 60, step: 1, format: seconds },
        ],
      },
      {
        title: "Advanced",
        fields: [
          { kind: "slider", key: "bigSkipSeconds", label: "Long jump with Shift", info: "How far the arrow keys move while Shift is held.", min: 10, max: 300, step: 5, format: seconds },
        ],
      },
    ],
  },
  {
    id: "video-video", title: "Video", icon: "video",
    note: "Changes to how video is decoded take effect the next time a video starts.",
    groups: [
      {
        title: "Picture",
        fields: [
          { kind: "choice", key: "deinterlace", label: "Remove interlacing", info: "Smooths out the comb-like lines in old TV recordings; Automatic only does it when the video needs it.", options: [["auto", "Automatic"], ["on", "Always"], ["off", "Never"]] },
        ],
      },
      {
        title: "Advanced",
        fields: [
          { kind: "choice", key: "skipLoopFilter", label: "Picture clean-up", info: "Skipping a clean-up step makes busy computers keep up, at the cost of a slightly softer picture.", options: [["normal", "Best quality"], ["faster", "Faster, a bit softer"]] },
          { kind: "toggle", key: "fastDecode", label: "Allow quick decoding shortcuts", info: "Speeds up slow computers but can cause small glitches in the picture." },
        ],
      },
    ],
  },
  {
    id: "video-audio", title: "Audio", icon: "audioTrack",
    note: "Default audio language, the equalizer and the audio delay are in the player's side panel.",
    groups: [
      {
        title: "Sound",
        fields: [
          { kind: "slider", key: "volumeStep", label: "Volume step", info: "How much the up and down arrow keys change the volume.", min: 1, max: 20, step: 1, format: (v) => `${v}%` },
        ],
      },
      {
        title: "Advanced",
        fields: [
          { kind: "choice", key: "replayGain", label: "Even out loudness", info: "Uses the loudness information stored in music files so tracks or albums play at a similar volume.", options: [["none", "Off"], ["track", "Per track"], ["album", "Per album"]] },
        ],
      },
    ],
  },
  {
    id: "video-subtitles", title: "Subtitles", icon: "subtitles",
    note: "Subtitle font, size, delay and language are in the player's Subtitles panel. These settings are for the short messages over the picture.",
    groups: [
      {
        title: "On-screen messages",
        fields: [
          { kind: "toggle", key: "showOsd", label: "Show on-screen messages", info: "Briefly shows what just happened, such as the volume, the time or the speed, over the video." },
          { kind: "slider", key: "osdSeconds", label: "How long they stay", info: "How many seconds each message stays on screen.", min: 0.3, max: 5, step: 0.1, format: seconds },
        ],
      },
      {
        title: "Advanced",
        fields: [
          { kind: "toggle", key: "showKeys", label: "Show the key I pressed", info: "Adds a small key cap to the message so you can learn which key does what." },
        ],
      },
    ],
  },
  {
    id: "video-library", title: "Library", icon: "film",
    groups: [
      {
        title: "History",
        fields: [
          { kind: "toggle", key: "keepHistory", label: "Keep a list of recent videos", info: "Adds the videos you play to the Recent list; turn it off for more privacy." },
          { kind: "button", label: "Recent list", info: "Empties the Recent list. Your videos stay where they are.", text: "Clear", run: (b) => confirmed(b, () => {
            hostRef.config.video.recent = [];
            hostRef.configChanged();
          }) },
        ],
      },
      {
        title: "Advanced",
        fields: [
          { kind: "button", label: "Watch progress", info: "Forgets where you stopped in every video, so none of them offers to continue.", text: "Clear", run: (b) => confirmed(b, () => {
            hostRef.config.video.positions = {};
            hostRef.configChanged();
          }) },
          { kind: "button", label: "Recent web addresses", info: "Empties the list of streams you opened from an address.", text: "Clear", run: (b) => confirmed(b, () => {
            mediaSettings({ config: hostRef.config }).recentUrls = [];
            hostRef.configChanged();
          }) },
        ],
      },
    ],
  },
  {
    id: "video-network", title: "Network", icon: "network",
    note: "Buffering changes apply the next time a video starts.",
    groups: [
      {
        title: "Streams",
        fields: [
          { kind: "choice", key: "networkCaching", label: "Buffering", info: "How much of a web stream is loaded ahead: more avoids stuttering on a slow connection, less starts faster.", menu: true, options: [[300, "Low · starts fast"], [1000, "Normal"], [3000, "High · fewer stutters"], [8000, "Very high"]] },
          { kind: "toggle", key: "rememberUrls", label: "Remember web addresses", info: "Keeps the addresses you open in Network Stream so you can pick them again." },
          { kind: "toggle", key: "detectPlaylists", label: "Open playlist addresses as lists", info: "Addresses of channel lists (M3U) open as a list of channels instead of trying to play the file itself." },
        ],
      },
      {
        title: "Advanced",
        fields: [
          { kind: "toggle", key: "httpReconnect", label: "Reconnect when a stream drops", info: "Tries to continue a web stream if the connection breaks for a moment." },
        ],
      },
    ],
  },
  {
    id: "video-performance", title: "Performance", icon: "speed",
    note: "These apply as soon as nothing is playing or converting; otherwise at the next start.",
    groups: [
      {
        title: "Decoding",
        fields: [
          { kind: "toggle", key: "hardwareDecoding", label: "Use the graphics chip", info: "Decodes video on your graphics hardware to save battery and processor time; turn it off if you see glitches or a green picture." },
        ],
      },
      {
        title: "Advanced",
        fields: [
          { kind: "choice", key: "threads", label: "Processor cores for decoding", info: "How many processor cores software decoding may use; Automatic is right for nearly everyone.", menu: true, options: [[0, "Automatic"], [1, "1 core"], [2, "2 cores"], [4, "4 cores"], [8, "8 cores"]] },
        ],
      },
    ],
  },
  {
    id: "video-recording", title: "Recording & Casting", icon: "desktop",
    groups: [
      {
        title: "Converting",
        fields: [
          { kind: "choice", key: "convertProfile", label: "Usual format", info: "The format Convert suggests first.", menu: true, options: CONVERT_PROFILES.map((p) => [p.id, p.label] as [string, string]) },
          { kind: "choice", key: "convertWhere", label: "Save converted files", info: "Put the new file next to the original, or always in one folder.", options: [["source", "Next to the original"], ["folder", "In a folder"]] },
          { kind: "folder", key: "convertFolder", label: "Folder", info: "Where converted files go when saving in a folder.", enabled: (s) => s.convertWhere === "folder" },
          { kind: "toggle", key: "convertNotify", label: "Tell me when it's done", info: "Shows a short message over the video when a conversion finishes or fails." },
        ],
      },
      {
        title: "Casting",
        fields: [
          { kind: "toggle", key: "castMenu", label: "Show Stream to Device in menus", info: "Adds the option to send a video to a TV or speaker to the player's menus." },
        ],
      },
    ],
  },
];

// ---- building rows -----------------------------------------------------------------------------------

/** The host of the page being built; the field actions are written against it. */
let hostRef: Host;
let tipId = 0;

/** A "two-step" button: the first click asks, the second one does it. */
function confirmed(button: HTMLButtonElement, run: () => void) {
  const before = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = before;
  if (button.dataset.armed) {
    delete button.dataset.armed;
    button.textContent = "Cleared";
    button.disabled = true;
    run();
    setTimeout(() => {
      button.textContent = before;
      button.disabled = false;
    }, 1800);
    return;
  }
  button.dataset.armed = "1";
  button.textContent = "Click again to confirm";
  setTimeout(() => {
    if (button.dataset.armed) {
      delete button.dataset.armed;
      button.textContent = before;
    }
  }, 3000);
}

/** The "i" next to a label: a quiet icon that shows one sentence on hover or keyboard focus. */
function infoIcon(text: string): HTMLElement {
  const id = `vs-tip-${++tipId}`;
  const tip = h("span", { class: "vs-tip", role: "tooltip", id }, text);
  const button = h("button", { class: "vs-info", type: "button", "aria-label": "About this setting", "aria-describedby": id }, icon("info", 14), tip);
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  return button;
}

const labelWithInfo = (field: Base) => h("span", { class: "vs-label" }, h("span", { class: "sf-label" }, field.label), infoIcon(field.info));

function buildPage(page: Page, host: Host, syncers: (() => void)[]): SettingsGroup[] {
  hostRef = host;
  const settings = () => mediaSettings({ config: host.config });
  const sync = () => syncers.forEach((fn) => fn());

  const commit = (key: Key, value: unknown) => {
    (settings() as unknown as Record<string, unknown>)[key] = value;
    host.configChanged();
    notifyMediaSettings([key]);
    sync();
  };
  const read = (key: Key) => (settings() as unknown as Record<string, unknown>)[key];

  const row = (field: Field): SettingsRow => {
    switch (field.kind) {
      case "toggle": {
        const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
        input.checked = read(field.key) === true;
        input.addEventListener("change", () => commit(field.key, input.checked));
        syncers.push(() => (input.checked = read(field.key) === true));
        return { label: field.label, el: h("label", { class: "sf-row sf-toggle" }, labelWithInfo(field), input) };
      }
      case "choice": {
        const options = field.options;
        const control = field.menu || options.length > 3 ? choiceMenu(field, read, commit, syncers) : choiceSegments(field, read, commit, syncers);
        return { label: field.label, el: h("div", { class: "sf-row plain" }, labelWithInfo(field), control) };
      }
      case "slider": {
        const input = h("input", { type: "range", min: field.min, max: field.max, step: field.step });
        const value = h("span", { class: "sf-value" });
        const show = () => {
          const v = Number(read(field.key));
          input.value = String(v);
          value.textContent = field.format(v);
        };
        // Dragging only updates the label; the setting is saved when the drag ends.
        input.addEventListener("input", () => (value.textContent = field.format(Number(input.value))));
        input.addEventListener("change", () => commit(field.key, Number(input.value)));
        syncers.push(show);
        show();
        return { label: field.label, el: h("div", { class: "sf-row" }, labelWithInfo(field), input, value) };
      }
      case "folder": {
        const choose = h("button", { class: "btn small", type: "button" });
        const clear = h("button", { class: "btn small ghost", type: "button" }, "Clear");
        const show = () => {
          const path = String(read(field.key) ?? "");
          choose.replaceChildren(icon("folder", 14), path ? basename(path) : "Choose Folder…");
          choose.title = path;
          clear.hidden = !path;
          const enabled = field.enabled ? field.enabled(settings()) : true;
          choose.disabled = !enabled;
          clear.disabled = !enabled;
        };
        choose.addEventListener("click", async () => {
          try {
            const current = String(read(field.key) ?? "");
            const picked = await open({ directory: true, multiple: false, defaultPath: current || undefined });
            if (typeof picked === "string") commit(field.key, picked);
          } catch (err) {
            console.warn("Folder dialog failed:", err);
          }
        });
        clear.addEventListener("click", () => commit(field.key, ""));
        syncers.push(show);
        show();
        return { label: field.label, el: h("div", { class: "sf-row plain" }, labelWithInfo(field), h("div", { class: "st-inline" }, clear, choose)) };
      }
      case "button": {
        const button = h("button", { class: "btn small", type: "button" }, field.text);
        button.addEventListener("click", () => field.run(button));
        return { label: field.label, el: h("div", { class: "sf-row plain" }, labelWithInfo(field), button) };
      }
      case "profiles": {
        const panel = profilesPanel({
          get config() { return host.config; },
          save: () => host.configChanged(),
          // A profile switch rewrites settings on every page, not just this one.
          changed: () => {
            host.configChanged();
            sync();
          },
        });
        return { label: field.label, el: h("div", { class: "sf-row wide" }, labelWithInfo(field), panel) };
      }
    }
  };

  const groups = page.groups.map((g) => ({ title: g.title, rows: g.fields.map(row) }));
  syncers.forEach((fn) => fn());
  return groups;
}

function choiceSegments(field: Extract<Field, { kind: "choice" }>, read: (k: Key) => unknown, commit: (k: Key, v: unknown) => void, syncers: (() => void)[]) {
  const group = h("div", { class: "segmented" });
  const buttons = field.options.map(([value, text]) => {
    const button = h("button", { type: "button" }, text);
    button.addEventListener("click", () => commit(field.key, value));
    group.append(button);
    return [value, button] as const;
  });
  const show = () => buttons.forEach(([value, button]) => button.classList.toggle("active", read(field.key) === value));
  syncers.push(show);
  show();
  return group;
}

function choiceMenu(field: Extract<Field, { kind: "choice" }>, read: (k: Key) => unknown, commit: (k: Key, v: unknown) => void, syncers: (() => void)[]) {
  const select = h("select", { "aria-label": field.label },
    ...field.options.map(([value, text]) => h("option", { value: String(value) }, text)));
  const numeric = typeof field.options[0][0] === "number";
  select.addEventListener("change", () => commit(field.key, numeric ? Number(select.value) : select.value));
  const show = () => (select.value = String(read(field.key)));
  syncers.push(show);
  show();
  return select;
}

/** The nine Video categories for the Settings page. */
export function videoCategories(host: Host): Category[] {
  // One list for all pages: a profile switch on one page updates the controls of the others.
  const syncers: (() => void)[] = [];
  return PAGES.map((page) => ({
    id: page.id,
    title: page.title,
    icon: page.icon,
    section: "Video",
    groups: buildPage(page, host, syncers),
    intro: page.note ? h("p", { class: "vs-note" }, page.note) : undefined,
  }));
}
