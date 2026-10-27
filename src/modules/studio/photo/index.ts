import { isRaw } from "./develop";
import type { StudioFactory } from "../app";
import { canEdit, extensionOf, photoApi } from "./api";
import { askNewCanvas } from "./dialogs";
import { PhotoEditor, type Opening } from "./editor";
import { probeGpu } from "./gl";
import { takeForPhoto } from "./handoff";
import { loadProject } from "./project";
import { normalizePhotoSettings } from "./settings";
import { PHOTO_PROJECT_EXTENSIONS } from "../app";

/** The section shows nothing for this: the user cancelled what Photo asked first. */
function cancelled() {
  const err = new Error("Cancelled");
  err.name = "Cancelled";
  return err;
}

/**
 * Studio's Photo: a picture or a `.coreimage` project opens as it is; without a path, it asks
 * for a new canvas's size first.
 */
export const createPhotoApp: StudioFactory = async (host, start) => {
  const gpu = probeGpu();
  if (!gpu.webgl2) throw new Error("This computer's graphics can't run Photo (no WebGL2).");
  let opening: Opening;
  const path = start.path;
  if (!path) {
    const settings = normalizePhotoSettings(host.shell.config.studio.apps.photo);
    const canvas = await askNewCanvas(settings.newCanvas, gpu.maxTexture);
    if (!canvas) throw cancelled();
    settings.newCanvas = canvas;
    host.shell.config.studio.apps.photo = settings;
    host.shell.saveConfig();
    opening = { kind: "new", canvas };
  } else if (PHOTO_PROJECT_EXTENSIONS.includes(extensionOf(path))) {
    opening = { kind: "project", path, project: loadProject(await photoApi.openProject(path), gpu.maxTexture) };
  } else if (extensionOf(path) === "psd") {
    const { readPsdFile } = await import("./psd");
    const { project, skipped } = await readPsdFile(await photoApi.readFile(path), gpu.maxTexture);
    if (skipped.length) host.toast(`Left out ${skipped.length} adjustment layer${skipped.length > 1 ? "s" : ""} Photo doesn't have: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}.`);
    opening = { kind: "project", path, project };
  } else {
    if (!canEdit(path) && !isRaw(path)) throw new Error(`Photo can't open .${extensionOf(path)} pictures yet.`);
    opening = { kind: "picture", path, decoded: await photoApi.decode(path, gpu.maxTexture), quick: takeForPhoto(path) };
  }
  const editor = new PhotoEditor(host);
  try {
    await editor.load(opening);
  } catch (err) {
    editor.dispose();
    throw err;
  }
  return editor;
};
