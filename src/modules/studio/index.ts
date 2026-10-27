import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { isMainWindow } from "../../shell/windows";
import { open } from "../../shared/dialog";
import { basename, dirname, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import { ago } from "../../notes/api";
import { fsApi } from "../files/api";
import "../files/ops/ops.css";
import { showToast } from "../files/ops/toast";
import "../office/office.css";
import { openDialog } from "../time/dialog";
import "../time/time-module.css";
import { errorText } from "../time/api";
import { editApi as videoApi, type Snapshot } from "./video/api";
import { PHOTO_EXTENSIONS, studioKindOf, VIDEO_PROJECT_EXTENSIONS, type Aspect, type StudioApp, type StudioFactory, type StudioHost, type StudioKind, type StudioStart } from "./app";
import "./studio.css";
import type { createRecorderPage } from "./record/page";

const RECENT_MAX = 40;

/** Each app is its own chunk, loaded the first time it's needed. */
const LOADERS: Record<StudioKind, () => Promise<StudioFactory>> = {
  photo: async () => (await import("./photo")).createPhotoApp,
  video: async () => (await import("./video")).createVideoApp,
};

const KIND_ICON: Record<StudioKind, IconName> = { photo: "photoEdit", video: "videoEdit" };
const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "3gp", "mts"];

type View = "home" | StudioKind | "record";

/** Asks about unsaved changes: save them, throw them away, or stay. */
function askSave(title: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    let answer: "save" | "discard" | "cancel" = "cancel";
    const choose = (a: typeof answer) => () => ((answer = a), dialog.close());
    const dialog = openDialog({
      title: `Save changes to “${title}”?`,
      icon: "save",
      tone: "work",
      class: "tt-confirm",
      body: [h("p", { class: "tt-dialog-text" }, "Your changes will be lost if you don't save them.")],
      foot: [
        h("button", { class: "btn", type: "button", onclick: choose("discard") }, "Don't Save"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: choose("cancel") }, "Cancel"),
        h("button", { class: "btn primary", type: "button", "data-autofocus": "", onclick: choose("save") }, "Save"),
      ],
      onClose: () => resolve(answer),
    });
  });
}

/**
 * Studio: Photo (a layered photo editor) and the Video Editor (reels and videos on a timeline).
 * Like Office, it has a rail of its own: Home, Photo, Video, then the projects open right now.
 */
export const createStudioModule: ModuleFactory = (shell) => {
  const settings = () => shell.config.studio;
  const apps: StudioApp[] = [];
  let current: StudioApp | null = null;
  let view: View = "home";
  let visible = false;
  const toast = (text: string) => showToast(text, undefined, 3200);

  // ---- rail

  const railButton = (id: View, glyph: IconName, title: string) =>
    h("button", { class: `of-rail-btn${id === "home" ? "" : ` tone-${id}`}`, type: "button", title, "aria-label": title, onclick: () => (id === "record" ? showRecorder() : showHome(id)) }, icon(glyph, 20));
  const homeButtons: [View, HTMLButtonElement][] = [
    ["home", railButton("home", "home", "Home")],
    ["photo", railButton("photo", "photoEdit", "Photo")],
    ["video", railButton("video", "videoEdit", "Video Editor")],
    ["record", railButton("record", "recRecord", "Screen Recorder")],
  ];
  const files = h("div", { class: "of-rail-files" });
  const rail = h("nav", { class: "of-rail", "aria-label": "Studio" },
    homeButtons[0][1], h("div", { class: "of-rail-sep" }), ...homeButtons.slice(1).map(([, b]) => b), h("div", { class: "of-rail-sep" }), files);

  function drawRail() {
    for (const [id, button] of homeButtons) button.classList.toggle("active", !current && id === view);
    files.replaceChildren(...apps.map((app) => {
      const b = h("button", {
        class: `of-rail-btn tone-${app.kind}${app === current ? " active" : ""}`, type: "button",
        title: `${app.title()}${app.dirty() ? " (edited)" : ""}${app.path() ? `\n${app.path()}` : ""}`, "aria-label": app.title(),
        onclick: () => showApp(app),
        onauxclick: (e: MouseEvent) => e.button === 1 && void closeApp(app),
      }, icon(KIND_ICON[app.kind], 19), app.dirty() ? h("span", { class: "of-rail-dot" }) : null);
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: "Save", icon: "save", shortcut: "Ctrl+S", action: () => void app.save() },
          { label: "Save As…", icon: "saveAs", shortcut: "Ctrl+Shift+S", action: () => void app.save(true) },
          ...(app.path() ? [{ label: "Show in Files", icon: "folder" as IconName, action: () => shell.open({ kind: "folder", path: dirname(app.path()!) }) }] : []),
          "separator",
          { label: "Close", icon: "close", shortcut: "Ctrl+W", action: () => void closeApp(app) },
        ]);
      });
      return b;
    }));
  }

  // ---- Home

  const hubBody = h("div", { class: "of-hub-body" });
  const hub = h("div", { class: "of-hub" }, hubBody);
  const appHost = h("div", { class: "of-editors of-editor" });
  const main = h("div", { class: "of-main" }, hub, appHost);
  const el = h("section", { class: "office studio" }, rail, main);

  const tile = (kind: StudioKind, title: string, sub: string, shape: string, run: () => void) =>
    h("button", { class: `of-tile tone-${kind}`, type: "button", onclick: run },
      h("div", { class: `of-tile-page sd-tile ${shape}` }, h("span", { class: "sd-tile-frame" }), h("span", { class: "of-tile-badge" }, icon(KIND_ICON[kind], 15))),
      h("span", { class: "of-tile-name" }, title),
      h("span", { class: "of-tile-kind" }, sub));

  const videoTiles = () => ([
    ["9:16", "Reel", "TikTok, Reels, Shorts"],
    ["16:9", "Video", "YouTube, landscape"],
    ["1:1", "Square", "Feed post"],
    ["4:5", "Portrait", "Instagram post"],
  ] as [Aspect, string, string][]).map(([aspect, title, sub]) => tile("video", title, sub, `r${aspect.replace(":", "x")}`, () => void start("video", { aspect })));

  function recentRows(kind?: StudioKind) {
    const paths = settings().recent.filter((p) => !kind || studioKindOf(p) === kind);
    if (!paths.length) return h("div", { class: "of-recent" }, h("div", { class: "of-empty-line" }, "Pictures and projects you open show up here."));
    return h("div", { class: "of-recent" }, ...paths.slice(0, 20).map((path) => {
      const k = studioKindOf(path) ?? "photo";
      const when = h("span", { class: "of-recent-when" });
      void fsApi.stat(path).then((e) => (when.textContent = ago(e.mtime * 1000)), () => (when.textContent = "Not found"));
      return h("div", { class: `of-recent-row tone-${k}`, role: "button", tabindex: "0", title: path, onclick: () => void openPath(path) },
        h("span", { class: "of-kind" }, icon(KIND_ICON[k], 15)),
        h("span", { class: "of-recent-name" }, basename(path)),
        h("span", { class: "of-recent-path" }, dirname(path).replace(/^\/home\/[^/]+/, "~")),
        when,
        h("button", { class: "icon-btn small", type: "button", title: "Remove from the list", "aria-label": "Remove from the list", onclick: (e: Event) => (e.stopPropagation(), forget(path)) }, icon("close", 13)));
    }));
  }

  /** Video projects AutoRecover kept when Zazabor stopped without saving them. */
  function recoveredRows(): HTMLElement {
    const box = h("div", { class: "sd-recovered", hidden: true });
    void videoApi.recoveryList().then((list: Snapshot[]) => {
      const fresh = list.filter((r) => !apps.some((a) => a.kind === "video" && a.path() !== null && a.path() === r.path));
      if (!fresh.length) return;
      box.hidden = false;
      box.replaceChildren(
        h("div", { class: "of-hub-head" }, h("h2", null, "Recovered"), h("span", { class: "spacer" })),
        h("div", { class: "of-recent" }, ...fresh.map((r) =>
          h("div", { class: "of-recent-row tone-video", role: "button", tabindex: "0", title: r.path ?? "Never saved", onclick: () => void start("video", { recover: r.id }) },
            h("span", { class: "of-kind" }, icon("videoEdit", 15)),
            h("span", { class: "of-recent-name" }, r.title),
            h("span", { class: "of-recent-path" }, r.path ? dirname(r.path).replace(/^\/home\/[^/]+/, "~") : "Not saved yet"),
            h("span", { class: "of-recent-when" }, ago(r.saved)),
            h("button", { class: "icon-btn small", type: "button", title: "Discard this copy", "aria-label": "Discard this copy", onclick: (e: Event) => {
              e.stopPropagation();
              void videoApi.recoveryDelete(r.id).then(drawHub);
            } }, icon("trash", 13))))),
      );
    }).catch(() => undefined);
    return box;
  }

  /** Screen Recorder: a page of its own (not a project), made the first time it's shown. */
  let recorder: ReturnType<typeof createRecorderPage> | null = null;
  const recorderHost = h("div", { class: "sd-recorder", hidden: true });
  main.append(recorderHost);

  const recordTile = () => h("button", { class: "of-tile tone-record", type: "button", onclick: () => showRecorder() },
    h("div", { class: "of-tile-page sd-tile r16x9 sd-record-tile" }, h("span", { class: "sd-record-dot" }), h("span", { class: "of-tile-badge" }, icon("recRecord", 15))),
    h("span", { class: "of-tile-name" }, "Record Screen"),
    h("span", { class: "of-tile-kind" }, "Screen, window or area"));

  async function showRecorder() {
    current?.deactivate();
    current = null;
    view = "record";
    hub.hidden = true;
    appHost.hidden = true;
    for (const app of apps) app.el.hidden = true;
    recorderHost.hidden = false;
    drawRail();
    retitle();
    if (!recorder) {
      const { createRecorderPage } = await import("./record/page");
      recorder = createRecorderPage({
        config: shell.config,
        saveConfig: () => shell.saveConfig(),
        toast: (text, action) => showToast(text, action, 4000),
        openInEditor: (path) => void start("video", { paths: [path], aspect: "16:9" }),
        showInFiles: (path) => shell.open({ kind: "folder", path: dirname(path) }),
        showFolder: (path) => shell.open({ kind: "folder", path }),
        play: (path) => shell.open({ kind: "video", path }),
        finished: () => {
          shell.showModule("studio");
          if (view !== "record") void showRecorder();
        },
      });
      recorderHost.append(recorder.el);
    }
    recorder.show();
  }

  function hideRecorder() {
    recorderHost.hidden = true;
    recorder?.hide();
  }

  function drawHub() {
    // A function: Home and Photo each need their own tiles (a node has one parent).
    const photoTiles = () => [
      tile("photo", "Edit a Photo", "Open a picture", "r4x3", () => void browse("photo")),
      tile("photo", "New Canvas", "1080 × 1080", "r1x1", () => void start("photo", {})),
    ];
    const head = (title: string, kind?: StudioKind) => h("div", { class: "of-hub-head" }, h("h2", null, title), h("span", { class: "spacer" }),
      h("button", { class: "btn small", type: "button", onclick: () => void browse(kind) }, icon("open", 14), "Open…"));
    const parts: Record<View, Node[]> = {
      home: [
        h("h1", null, "Studio"),
        h("p", { class: "of-hub-sub" }, "Edit photos with layers and adjustments, or cut a reel with text, music and transitions."),
        h("div", { class: "of-new" }, ...photoTiles(), ...videoTiles().slice(0, 2), recordTile()),
        recoveredRows(),
        head("Recent"), recentRows(),
      ],
      record: [],
      photo: [
        h("h1", null, "Photo"),
        h("p", { class: "of-hub-sub" }, "Layers, masks, adjustments and filters. The original picture is never overwritten unless you ask."),
        h("div", { class: "of-new" }, ...photoTiles()),
        head("Recent pictures", "photo"), recentRows("photo"),
      ],
      video: [
        h("h1", null, "Video Editor"),
        h("p", { class: "of-hub-sub" }, "Cut clips on a timeline, add text, music, transitions and filters, and export for every platform."),
        h("div", { class: "of-new" }, ...videoTiles()),
        recoveredRows(),
        head("Recent projects", "video"), recentRows("video"),
      ],
    };
    hubBody.replaceChildren(...parts[view]);
  }

  // ---- showing things

  function showHome(next: View = "home") {
    if (next === "record") return void showRecorder();
    hideRecorder();
    current?.deactivate();
    current = null;
    view = next;
    hub.hidden = false;
    appHost.hidden = true;
    for (const app of apps) app.el.hidden = true;
    drawHub();
    drawRail();
    retitle();
  }

  function showApp(app: StudioApp) {
    hideRecorder();
    if (current && current !== app) current.deactivate();
    current = app;
    hub.hidden = true;
    appHost.hidden = false;
    for (const other of apps) other.el.hidden = other !== app;
    drawRail();
    retitle();
    if (visible) app.activate();
  }

  function retitle() {
    if (isMainWindow) return;
    const title = current ? `${current.title()}${current.dirty() ? " •" : ""} — Studio` : "Studio — Zazabor";
    void getCurrentWindow().setTitle(title).catch(() => undefined);
  }

  function remember(path: string) {
    settings().recent = [path, ...settings().recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
    shell.saveConfig();
  }

  function forget(path: string) {
    settings().recent = settings().recent.filter((p) => p !== path);
    shell.saveConfig();
    drawHub();
  }

  function hostFor(get: () => StudioApp | null): StudioHost {
    return {
      shell,
      changed: () => (drawRail(), retitle()),
      showHome: () => showHome(view),
      remember,
      toast,
      close: () => {
        const app = get();
        if (app) void closeApp(app, false);
      },
    };
  }

  async function start(kind: StudioKind, how: StudioStart) {
    if (how.path) {
      const already = apps.find((a) => a.path() === how.path);
      if (already) return showApp(already);
    }
    if (how.recover) drawHub();
    try {
      const factory = await LOADERS[kind]();
      let made: StudioApp | null = null;
      const app = await factory(hostFor(() => made), how);
      made = app;
      app.el.hidden = true;
      appHost.append(app.el);
      apps.push(app);
      showApp(app);
      if (how.path) remember(how.path);
    } catch (err) {
      if ((err as Error)?.name !== "Cancelled") toast(errorText(err));
    }
  }

  /** A file: a picture or .coreimage goes to Photo, a .corevideo project or a clip to the Video Editor. */
  async function openPath(path: string) {
    const kind = studioKindOf(path);
    if (kind) return start(kind, { path });
    if (VIDEO_EXTENSIONS.includes(path.slice(path.lastIndexOf(".") + 1).toLowerCase())) return start("video", { paths: [path], aspect: "9:16" });
    toast("Studio opens pictures, videos and its own projects.");
  }

  async function browse(kind?: StudioKind) {
    const filters = [
      ...(kind !== "video" ? [{ name: "Pictures", extensions: PHOTO_EXTENSIONS }] : []),
      ...(kind !== "photo" ? [{ name: "Video projects and clips", extensions: [...VIDEO_PROJECT_EXTENSIONS, ...VIDEO_EXTENSIONS] }] : []),
    ];
    const picked = await open({ title: kind === "photo" ? "Edit a Photo" : kind === "video" ? "Open a Video Project" : "Open", multiple: true, filters }).catch(() => null);
    for (const path of picked ?? []) await openPath(path);
  }

  async function closeApp(app: StudioApp, ask = true): Promise<boolean> {
    if (ask && app.dirty()) {
      if (current !== app) showApp(app);
      const answer = await askSave(app.title());
      if (answer === "cancel") return false;
      if (answer === "save" && !(await app.save())) return false;
    }
    const index = apps.indexOf(app);
    if (index < 0) return true;
    apps.splice(index, 1);
    app.deactivate();
    app.dispose();
    app.el.remove();
    if (current === app) {
      current = null;
      const next = apps[index] ?? apps[index - 1];
      if (next) showApp(next);
      else showHome(view);
    } else drawRail();
    return true;
  }

  // Closing the window with unsaved projects asks about each.
  let closing = false;
  const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
    if (closing) return event.preventDefault();
    const unsaved = apps.filter((a) => a.dirty());
    if (!unsaved.length) return;
    event.preventDefault();
    closing = true;
    try {
      shell.showModule("studio");
      for (const app of unsaved) if (!(await closeApp(app))) return;
    } finally {
      closing = false;
    }
    await getCurrentWindow().destroy();
  });

  showHome("home");

  const module: AppModule = {
    id: "studio",
    title: "Studio",
    icon: "studio",
    el,
    activate() {
      visible = true;
      if (current) current.activate();
      else if (view === "record") recorder?.show();
      else drawHub();
    },
    deactivate() {
      visible = false;
      current?.deactivate();
      recorder?.hide();
    },
    handleKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "o") {
        void browse(current?.kind);
        return true;
      }
      if (current) {
        if (mod && key === "w") {
          void closeApp(current);
          return true;
        }
        if (mod && key === "s") {
          void current.save(e.shiftKey);
          return true;
        }
        return current.handleKey(e);
      }
      return false;
    },
    open(request) {
      if (request.kind !== "studio") return;
      if (request.app === "photo" && request.path) void start("photo", { path: request.path });
      else if (request.app === "video" && request.path && studioKindOf(request.path) === "video") void start("video", { path: request.path });
      else if (request.app === "video") void start("video", { paths: request.paths ?? (request.path ? [request.path] : []), aspect: "9:16", make: request.make });
      else void start(request.app, {});
    },
    windowPath: () => current?.path() ?? null,
    // The user guide: F1 opens the article for the app showing; its Open button shows a page.
    guideTopic: () => {
      const kind = current?.kind ?? (view === "home" ? null : view);
      if (!current && view === "record") return "screen-recorder";
      return kind === "photo" ? "photo" : kind === "video" ? "video-editor" : "studio";
    },
    showGuideTarget(target) {
      if (target === "home" || target === "photo" || target === "video") showHome(target);
      else if (target === "record") void showRecorder();
    },
    dispose() {
      void unlistenClose.then((fn) => fn());
      recorder?.dispose();
      for (const app of apps) app.dispose();
      el.remove();
    },
  };
  return module;
};
