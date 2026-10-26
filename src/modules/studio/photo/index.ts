import type { StudioFactory } from "../app";
import { canEdit, extensionOf, photoApi } from "./api";
import { askNewCanvas } from "./dialogs";
import { PhotoEditor, type Opening } from "./editor";
import { probeGpu } from "./gl";
import { takeForPhoto } from "./handoff";
import { loadProject } from "./project";
import { normalizePhotoSettings } from "./settings";

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
  } else if (extensionOf(path) === "coreimage") {
    opening = { kind: "project", path, project: loadProject(await photoApi.openProject(path), gpu.maxTexture) };
  } else {
    if (!canEdit(path)) throw new Error(`Photo can't open .${extensionOf(path)} pictures yet.`);
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
