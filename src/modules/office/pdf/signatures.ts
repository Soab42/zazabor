import { invoke } from "@tauri-apps/api/core";
import { open } from "../../../shared/dialog";
import { basename, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { errorText } from "../../time/api";
import { openDialog, textInput } from "../../time/dialog";
import { popover } from "../../time/pickers";
import { extensionOf, officeApi } from "../api";

/**
 * Fill & Sign's signatures and initials: typed, drawn or taken from a picture, kept (when the
 * user says so) in CorePro's own store, and put on pages as pictures. They aren't certificate
 * signatures: anyone can see who signed, nothing proves it.
 */

export type SignatureKind = "signature" | "initials";

export interface Signature {
  id: string;
  kind: SignatureKind;
  name: string;
  /** A PNG data URL, trimmed to the ink. */
  image: string;
  created: number;
}

export const signatureApi = {
  list: () => invoke<Signature[]>("pdf_signatures"),
  add: (kind: SignatureKind, name: string, image: string) => invoke<Signature>("pdf_signature_add", { kind, name, image }),
  remove: (id: string) => invoke<void>("pdf_signature_delete", { id }),
};

/** What to put on the page: a picture and what it says (its alternative text). */
export interface Ink {
  image: string;
  name: string;
}

/** The ink colour, as Acrobat's default (black). */
const INK = "#16161d";

/** Typed signatures' lettering: a script, an italic serif, and the system's handwriting face. */
const STYLES = [
  { id: "script", label: "Script", font: (px: number) => `italic 500 ${px}px Z003, "URW Chancery L", "Apple Chancery", cursive` },
  { id: "serif", label: "Serif", font: (px: number) => `italic ${px}px "DejaVu Serif", Georgia, serif` },
  { id: "hand", label: "Hand", font: (px: number) => `${px}px cursive` },
];

/** A canvas cut down to its ink, with a small margin; null when it's empty. */
function trim(canvas: HTMLCanvasElement, pad = 6): HTMLCanvasElement | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = h("canvas", { width: x1 - x0 + 1, height: y1 - y0 + 1 });
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Lettering drawn large enough to print sharply. */
function typed(text: string, style: (typeof STYLES)[number]): HTMLCanvasElement | null {
  const px = 120;
  const canvas = h("canvas", { width: 10, height: 10 });
  let ctx = canvas.getContext("2d")!;
  ctx.font = style.font(px);
  const width = Math.ceil(ctx.measureText(text).width) + px;
  canvas.width = Math.min(width, 2400);
  canvas.height = Math.round(px * 1.8);
  ctx = canvas.getContext("2d")!;
  ctx.font = style.font(px);
  ctx.fillStyle = INK;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, px / 2, px * 1.25, canvas.width - px);
  return trim(canvas);
}

/** A picture of a signature: paper (near white) becomes transparent, ink stays. */
async function fromPicture(blob: Blob): Promise<HTMLCanvasElement | null> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = h("canvas", { width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)) });
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const light = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // Paper fades out over a short range, so the ink's edges stay smooth.
    const alpha = light >= 215 ? 0 : light <= 170 ? 1 : (215 - light) / 45;
    d[i + 3] = Math.round(d[i + 3] * alpha);
  }
  ctx.putImageData(image, 0, 0);
  return trim(canvas);
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", bmp: "image/bmp", gif: "image/gif" };

/**
 * Add Signature / Add Initials: Type, Draw or Image, and whether to keep it. Resolves with the
 * ink, or null when cancelled.
 */
export function signatureDialog(kind: SignatureKind, toast: (text: string) => void): Promise<Ink | null> {
  return new Promise((resolve) => {
    let result: Ink | null = null;
    let mode: "type" | "draw" | "image" = "type";
    let style = STYLES[0];
    let picture: HTMLCanvasElement | null = null;
    let pictureName = "";

    // ---- type
    const name = textInput({ placeholder: kind === "initials" ? "Your initials" : "Your name", "aria-label": kind === "initials" ? "Initials" : "Name", maxlength: "60", "data-autofocus": "" });
    const preview = h("div", { class: "pf-sig-preview", "aria-hidden": "true" });
    const styleButtons = STYLES.map((s) => h("button", {
      class: "pf-sig-style", type: "button", title: s.label, style: { font: s.font(22) },
      onclick: () => {
        style = s;
        drawTyped();
      },
    }, "Abc"));
    const drawTyped = () => {
      preview.textContent = name.value || (kind === "initials" ? "AB" : "Your name");
      preview.style.font = style.font(46);
      preview.classList.toggle("empty", !name.value);
      styleButtons.forEach((b, i) => b.classList.toggle("on", STYLES[i] === style));
    };
    name.addEventListener("input", drawTyped);
    const typePanel = h("div", { class: "pf-sig-panel" }, name, h("div", { class: "pf-sig-styles" }, ...styleButtons), preview);

    // ---- draw
    const pad = h("canvas", { class: "pf-sig-pad", width: 1040, height: 320, "aria-label": "Draw here" });
    const strokes: { x: number; y: number }[][] = [];
    const paint = () => {
      const ctx = pad.getContext("2d")!;
      ctx.clearRect(0, 0, pad.width, pad.height);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const s of strokes) {
        ctx.beginPath();
        ctx.moveTo(s[0].x, s[0].y);
        if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y);
        // Through the midpoints, so the line is smooth rather than jagged.
        for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
        if (s.length > 1) ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y);
        ctx.stroke();
      }
      drawHint.hidden = strokes.length > 0;
    };
    const at = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
    };
    pad.addEventListener("pointerdown", (e) => {
      pad.setPointerCapture(e.pointerId);
      strokes.push([at(e)]);
      paint();
    });
    pad.addEventListener("pointermove", (e) => {
      if (!pad.hasPointerCapture(e.pointerId)) return;
      strokes[strokes.length - 1].push(at(e));
      paint();
    });
    const drawHint = h("span", { class: "pf-sig-hint" }, kind === "initials" ? "Draw your initials" : "Draw your signature");
    const drawPanel = h("div", { class: "pf-sig-panel" },
      h("div", { class: "pf-sig-pad-wrap" }, pad, h("span", { class: "pf-sig-line" }), drawHint),
      h("div", { class: "pf-sig-row" }, h("span", { class: "spacer" }), h("button", { class: "btn small", type: "button", onclick: () => ((strokes.length = 0), paint()) }, icon("eraser", 14), "Clear")));

    // ---- image
    const imageBox = h("div", { class: "pf-sig-image" }, h("span", { class: "pf-sig-hint" }, "A photo or scan of your signature on white paper"));
    const choose = async () => {
      const picked = await open({ title: "Choose a Signature Picture", multiple: false, filters: [{ name: "Pictures", extensions: Object.keys(MIME) }] }).catch(() => null);
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      try {
        const bytes = await officeApi.read(path);
        const canvas = await fromPicture(new Blob([bytes as BlobPart], { type: MIME[extensionOf(path)] ?? "image/png" }));
        if (!canvas) return dialog.error("There's no signature in that picture: it looks blank.");
        dialog.error("");
        picture = canvas;
        pictureName = basename(path);
        imageBox.replaceChildren(h("img", { src: canvas.toDataURL("image/png"), alt: "" }));
      } catch (err) {
        dialog.error(`Couldn’t read ${basename(path)}: ${errorText(err)}`);
      }
    };
    const imagePanel = h("div", { class: "pf-sig-panel" }, imageBox,
      h("div", { class: "pf-sig-row" }, h("span", { class: "spacer" }), h("button", { class: "btn small", type: "button", onclick: () => void choose() }, icon("image", 14), "Choose a Picture…")));

    // ---- frame
    const panels = { type: typePanel, draw: drawPanel, image: imagePanel };
    const tabs = (["type", "draw", "image"] as const).map((m) => h("button", {
      class: "pf-seg-btn", type: "button", role: "tab",
      onclick: () => {
        mode = m;
        show();
      },
    }, m === "type" ? "Type" : m === "draw" ? "Draw" : "Image"));
    const show = () => {
      tabs.forEach((t, i) => t.classList.toggle("on", (["type", "draw", "image"] as const)[i] === mode));
      for (const [m, panel] of Object.entries(panels)) panel.hidden = m !== mode;
      dialog?.error("");
      if (mode === "type") requestAnimationFrame(() => name.focus());
    };
    const keep = h("input", { type: "checkbox", checked: true });
    const add = async () => {
      let canvas: HTMLCanvasElement | null = null;
      let label = "";
      if (mode === "type") {
        label = name.value.trim();
        if (!label) return dialog.error(kind === "initials" ? "Type your initials." : "Type your name.");
        canvas = typed(label, style);
      } else if (mode === "draw") {
        canvas = trim(pad);
        label = kind === "initials" ? "Initials" : "Signature";
      } else {
        canvas = picture;
        label = pictureName.replace(/\.[^.]+$/, "") || "Signature";
      }
      if (!canvas) return dialog.error(mode === "draw" ? "Draw first." : "Choose a picture first.");
      const image = canvas.toDataURL("image/png");
      if (keep.checked) {
        try {
          await signatureApi.add(kind, label, image);
        } catch (err) {
          toast(`It’s on the page, but it wasn’t kept: ${errorText(err)}`);
        }
      }
      result = { image, name: label };
      dialog.close();
    };
    const dialog = openDialog({
      title: kind === "initials" ? "Add Initials" : "Add Signature",
      subtitle: "A picture of your signature on the page, not a certificate signature.",
      icon: "signature",
      tone: "work",
      class: "pf-sig-dialog",
      body: [h("div", { class: "pf-seg", role: "tablist" }, ...tabs), typePanel, drawPanel, imagePanel,
        h("label", { class: "pf-check" }, keep, kind === "initials" ? "Keep these initials for next time" : "Keep this signature for next time")],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: () => void add() }, "Add"),
      ],
      submit: () => void add(),
      onClose: () => resolve(result),
    });
    drawTyped();
    paint();
    show();
  });
}

/**
 * Sign ▾: the signatures and initials kept, to pick one; Add Signature… and Add Initials…; a
 * kept one can be deleted from here.
 */
export function signatureMenu(anchor: HTMLElement, o: { pick: (ink: Ink) => void; create: (kind: SignatureKind) => void; toast: (text: string) => void }) {
  const list = h("div", { class: "pf-sig-list" }, h("div", { class: "pf-sig-empty" }, "Loading…"));
  const body = h("div", { class: "pf-sig-menu" },
    list,
    h("div", { class: "pf-sig-menu-foot" },
      h("button", { class: "rb-list-item", type: "button", onclick: () => (pop.close(), o.create("signature")) }, icon("signature", 14), " Add Signature…"),
      h("button", { class: "rb-list-item", type: "button", onclick: () => (pop.close(), o.create("initials")) }, icon("signature", 14), " Add Initials…")));
  const pop = popover(anchor, body, document.body);
  const tone = anchor.closest(".tone-pdf");
  if (tone) pop.el.classList.add("tone-pdf");
  const draw = (items: Signature[]) => {
    if (!items.length) {
      list.replaceChildren(h("div", { class: "pf-sig-empty" }, "No signatures kept yet."));
      return;
    }
    list.replaceChildren(...(["signature", "initials"] as const).flatMap((kind) => {
      const own = items.filter((s) => s.kind === kind);
      if (!own.length) return [];
      return [h("div", { class: "pf-sig-group" }, kind === "initials" ? "Initials" : "Signatures"), ...own.map((s) => h("div", { class: "pf-sig-item" },
        h("button", { class: "pf-sig-use", type: "button", title: `Place “${s.name}”`, onclick: () => (pop.close(), o.pick({ image: s.image, name: s.name })) }, h("img", { src: s.image, alt: s.name })),
        h("button", {
          class: "icon-btn small", type: "button", title: "Delete", "aria-label": `Delete ${s.name}`,
          onclick: async () => {
            try {
              await signatureApi.remove(s.id);
              draw(items.filter((x) => x.id !== s.id));
            } catch (err) {
              o.toast(`Couldn’t delete it: ${errorText(err)}`);
            }
          },
        }, icon("trash", 14))))];
    }));
  };
  signatureApi.list().then(draw, (err) => list.replaceChildren(h("div", { class: "pf-sig-empty" }, `Couldn’t read the kept signatures: ${errorText(err)}`)));
}

/** Fill & Sign's marks, drawn as pictures so every viewer shows them the same: ✓, ✗ and a dot. */
export function markImage(mark: "check" | "cross" | "dot"): string {
  const canvas = h("canvas", { width: 96, height: 96 });
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = 11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (mark === "check") {
    ctx.moveTo(14, 52);
    ctx.lineTo(38, 76);
    ctx.lineTo(82, 20);
    ctx.stroke();
  } else if (mark === "cross") {
    ctx.moveTo(18, 18);
    ctx.lineTo(78, 78);
    ctx.moveTo(78, 18);
    ctx.lineTo(18, 78);
    ctx.stroke();
  } else {
    ctx.arc(48, 48, 26, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toDataURL("image/png");
}
