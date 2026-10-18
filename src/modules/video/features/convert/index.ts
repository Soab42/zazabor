import type { UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { basename, dirname, h, rafThrottle, stripExtension } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { VideoContext } from "../../extensions";
import { CONVERT_PROFILES, isLocation, mediaApi, onConvert, type ConvertJob } from "../../media-api";
import { mediaSettings } from "../profiles/settings";
import { openDialog, type Dialog } from "../open/dialog";
import { sectionLabel } from "../open/ui";

const SOURCE_EXTENSIONS = ["mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "ogv", "3gp", "mp3", "flac", "ogg", "opus", "wav", "m4a", "aac"];

export interface ConvertFeature {
  /** Opens the Convert dialog, with `source` already in its list. */
  open(source?: string): void;
  dispose(): void;
}

const statusText = (job: ConvertJob): string => {
  switch (job.state) {
    case "running": return job.progress > 0 ? `Converting… ${Math.round(job.progress * 100)}%` : "Starting…";
    case "done": return "Finished";
    case "cancelled": return "Cancelled";
    default: return job.error ?? "The conversion didn't work.";
  }
};

/** Converting media to other formats: a dialog for choosing sources and format, and the job list. */
export function createConvert(ctx: VideoContext): ConvertFeature {
  const jobs = new Map<number, ConvertJob>();
  const subscribers = new Set<() => void>();
  let unlisten: UnlistenFn | undefined;
  let disposed = false;

  const changed = () => subscribers.forEach((fn) => fn());
  onConvert((job) => {
    const before = jobs.get(job.id)?.state;
    jobs.set(job.id, job);
    changed();
    if (before === "running" && job.state !== "running" && mediaSettings(ctx.shell).convertNotify) {
      if (job.state === "done") ctx.showOsd(`Converted · ${basename(job.dest)}`);
      else if (job.state === "failed") ctx.showOsd("A conversion didn't work");
    }
  })
    .then((fn) => (disposed ? fn() : (unlisten = fn)))
    .catch((err) => console.warn("Could not listen for conversions:", err));

  const openDialogFor = (preset?: string) => {
    const settings = mediaSettings(ctx.shell);
    const sources: string[] = preset ? [preset] : [];
    let profile: string = CONVERT_PROFILES.some((p) => p.id === settings.convertProfile) ? settings.convertProfile : CONVERT_PROFILES[0].id;
    let where = settings.convertWhere;
    let folder = settings.convertFolder;

    const dialog: Dialog = openDialog({ title: "Convert", subtitle: "Make a copy of a video or song in another format.", icon: "refresh", width: 600, onClose: () => subscribers.delete(renderJobs) });
    const sourceList = h("div", { class: "mt-list" });
    const formatList = h("div", { class: "mt-choices" });
    const destination = h("div", { class: "mt-dest" });
    const jobList = h("div", { class: "mt-list mt-jobs" });
    const jobHeading = h("div");
    const start = h("button", { class: "btn primary", type: "button" });
    const clear = h("button", { class: "btn ghost", type: "button" }, "Clear finished");

    const addFiles = h("button", { class: "btn small", type: "button" }, icon("plus", 14), "Add Files…");
    addFiles.addEventListener("click", async () => {
      try {
        const picked = await open({ multiple: true, filters: [{ name: "Video and audio", extensions: SOURCE_EXTENSIONS }] });
        const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
        for (const path of list) if (!sources.includes(path)) sources.push(path);
        renderSources();
      } catch (err) {
        console.warn("File dialog failed:", err);
      }
    });
    const addCurrent = h("button", { class: "btn small ghost", type: "button" }, "Add what's playing");
    addCurrent.addEventListener("click", () => {
      const current = ctx.player.current;
      if (current && !sources.includes(current)) sources.push(current);
      renderSources();
    });

    const renderSources = () => {
      const current = ctx.player.current;
      addCurrent.hidden = !current || sources.includes(current);
      if (!sources.length) {
        sourceList.replaceChildren(h("div", { class: "mt-drop" }, "Add the files you want to convert."));
      } else {
        sourceList.replaceChildren(...sources.map((path) => {
          const remove = h("button", { class: "icon-btn small", type: "button", title: "Remove", "aria-label": `Remove ${basename(path)}` }, icon("close", 14));
          remove.addEventListener("click", () => {
            sources.splice(sources.indexOf(path), 1);
            renderSources();
          });
          return h("div", { class: "mt-item static", title: path },
            h("span", { class: "mt-item-icon" }, icon("film", 18)),
            h("span", { class: "mt-item-text" }, h("span", { class: "mt-item-title" }, stripExtension(basename(path))), h("span", { class: "mt-item-meta" }, isLocation(path) ? path : dirname(path))),
            remove);
        }));
      }
      start.disabled = sources.length === 0;
      start.replaceChildren(icon("refresh", 15), sources.length > 1 ? `Convert ${sources.length} Files` : "Convert");
    };

    const renderFormats = () => {
      formatList.replaceChildren(...CONVERT_PROFILES.map((p) => {
        const b = h("button", { class: `mt-choice${p.id === profile ? " active" : ""}`, type: "button", role: "radio", "aria-checked": String(p.id === profile) },
          h("strong", null, p.label), h("span", null, p.detail));
        b.addEventListener("click", () => {
          profile = p.id;
          settings.convertProfile = p.id;
          ctx.shell.saveConfig();
          renderFormats();
        });
        return b;
      }));
    };

    const renderDestination = () => {
      const segmented = h("div", { class: "segmented" });
      for (const [value, label] of [["source", "Next to the original"], ["folder", "A folder"]] as const) {
        const b = h("button", { type: "button", class: where === value ? "active" : "" }, label);
        b.addEventListener("click", () => {
          where = value;
          settings.convertWhere = value;
          ctx.shell.saveConfig();
          renderDestination();
        });
        segmented.append(b);
      }
      const parts: Node[] = [segmented];
      if (where === "folder") {
        const choose = h("button", { class: "btn small", type: "button", title: folder }, icon("folder", 14), folder ? basename(folder) : "Choose Folder…");
        choose.addEventListener("click", async () => {
          try {
            const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
            if (typeof picked === "string") {
              folder = picked;
              settings.convertFolder = picked;
              ctx.shell.saveConfig();
              renderDestination();
            }
          } catch (err) {
            console.warn("Folder dialog failed:", err);
          }
        });
        parts.push(choose);
      }
      destination.replaceChildren(...parts);
    };

    const renderJobs = rafThrottle(() => {
      const all = [...jobs.values()].reverse();
      jobHeading.replaceChildren(...(all.length ? [sectionLabel("Conversions", ...(all.some((j) => j.state !== "running") ? [clear] : []))] : []));
      if (!all.length) {
        jobList.replaceChildren();
        return;
      }
      jobList.replaceChildren(...all.map((job) => {
        const bar = h("span", { class: "mt-progress" }, h("i"));
        bar.style.setProperty("--p", String(job.state === "done" ? 1 : job.progress));
        const end = job.state === "running"
          ? h("button", { class: "btn small ghost", type: "button" }, "Cancel")
          : job.state === "done"
            ? h("button", { class: "btn small", type: "button" }, icon("play", 13), "Play")
            : null;
        end?.addEventListener("click", () => {
          if (job.state === "running") void mediaApi.convertCancel(job.id);
          else {
            dialog.close();
            void ctx.play(job.dest);
          }
        });
        return h("div", { class: `mt-item static job ${job.state}`, title: job.dest },
          h("span", { class: "mt-item-icon" }, icon(job.state === "done" ? "check" : job.state === "failed" ? "info" : "refresh", 18)),
          h("span", { class: "mt-item-text" },
            h("span", { class: "mt-item-title" }, basename(job.dest)),
            job.state === "running" ? bar : null,
            h("span", { class: "mt-item-meta" }, statusText(job))),
          end);
      }));
    });
    subscribers.add(renderJobs);

    clear.addEventListener("click", async () => {
      try {
        await mediaApi.convertClear();
        for (const [id, job] of jobs) if (job.state !== "running") jobs.delete(id);
        changed();
      } catch (err) {
        console.warn("Could not clear conversions:", err);
      }
    });

    start.addEventListener("click", async () => {
      const queue = [...sources];
      sources.length = 0;
      renderSources();
      for (const source of queue) {
        const destDir = where === "folder" && folder ? folder : isLocation(source) ? folder : dirname(source);
        if (!destDir) {
          ctx.showOsd("Choose a folder to save the converted file");
          sources.push(source);
          continue;
        }
        try {
          const job = await mediaApi.convertStart(source, profile, destDir);
          if (!jobs.has(job.id)) jobs.set(job.id, job);
        } catch (err) {
          console.warn("Could not start the conversion:", err);
          jobs.set(-Date.now(), { id: -Date.now(), source, dest: source, profile, progress: 0, state: "failed", error: typeof err === "string" ? err : "The conversion couldn't start." });
        }
      }
      renderSources();
      changed();
    });

    dialog.body.append(
      sectionLabel("Files", addCurrent, addFiles), sourceList,
      sectionLabel("Format"), formatList,
      sectionLabel("Save to"), destination,
      jobHeading, jobList);
    dialog.foot.append(h("div", { class: "spacer" }), start);
    renderSources();
    renderFormats();
    renderDestination();
    // Pick up jobs from before the app's page was reloaded.
    mediaApi.convertJobs()
      .then((list) => {
        for (const job of list) if (!jobs.has(job.id)) jobs.set(job.id, job);
        renderJobs();
      })
      .catch(() => undefined);
    renderJobs();
    if (!sources.length && !jobs.size) addFiles.focus();
    else start.focus();
  };

  return {
    open: openDialogFor,
    dispose() {
      disposed = true;
      unlisten?.();
      subscribers.clear();
    },
  };
}
