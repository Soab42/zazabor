import type { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";

/**
 * Pictures as Word places them: in line with the text, or wrapped (Square, Top and Bottom), or
 * free on the page behind or in front of the text, moved by dragging or with the arrow keys.
 * Selected, a picture shows Word's Layout Options button and the Picture Format tab (tabs.ts).
 */

export type Wrap = "inline" | "square" | "topBottom" | "behind" | "front";
export type Align = "left" | "center" | "right";

export const WRAPS: { id: Wrap; label: string; icon: IconName }[] = [
  { id: "inline", label: "In Line with Text", icon: "wrapInline" },
  { id: "square", label: "Square", icon: "wrapSquare" },
  { id: "topBottom", label: "Top and Bottom", icon: "wrapTopBottom" },
  { id: "behind", label: "Behind Text", icon: "wrapBehind" },
  { id: "front", label: "In Front of Text", icon: "wrapFront" },
];

/** Placed anywhere on the page rather than in the flow of text. */
export const isFree = (wrap: unknown) => wrap === "behind" || wrap === "front";

const WRAP_IDS = WRAPS.map((w) => w.id) as string[];

function wrapOf(el: HTMLElement): Wrap {
  const own = el.getAttribute("data-wrap");
  if (own && WRAP_IDS.includes(own)) return own as Wrap;
  // A picture floated by another app's HTML (pasted from a web page or Word).
  return el.style.float === "left" || el.style.float === "right" ? "square" : "inline";
}

function alignOf(el: HTMLElement): Align {
  const own = el.getAttribute("data-align");
  if (own === "left" || own === "center" || own === "right") return own;
  return el.style.float === "right" ? "right" : "left";
}

/** The Wrap Text choices, ticked where the picture is. */
export function wrapItems(current: Wrap, set: (wrap: Wrap) => void): MenuItem[] {
  return WRAPS.map((w) => ({ label: `${w.label}${w.id === current ? "  ✓" : ""}`, icon: w.icon, action: () => set(w.id) }));
}

export const Picture = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      wrap: { default: "inline", parseHTML: (el: HTMLElement) => wrapOf(el), renderHTML: (a: Record<string, unknown>) => (a.wrap && a.wrap !== "inline" ? { "data-wrap": a.wrap } : {}) },
      align: { default: "left", parseHTML: (el: HTMLElement) => alignOf(el), renderHTML: (a: Record<string, unknown>) => (a.align && a.align !== "left" ? { "data-align": a.align } : {}) },
      // Behind or in front of the text: where it sits from the top left of its paragraph, in CSS pixels.
      x: { default: 0, parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-x")) || 0, renderHTML: (a: Record<string, unknown>) => (a.x ? { "data-x": String(a.x) } : {}) },
      y: { default: 0, parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-y")) || 0, renderHTML: (a: Record<string, unknown>) => (a.y ? { "data-y": String(a.y) } : {}) },
    };
  },

  addNodeView() {
    const parent = this.parent?.();
    if (!parent) return null;
    const editor = this.editor;
    return (props) => {
      const view = parent(props) as unknown as {
        dom: HTMLElement;
        update?: (node: PmNode, ...rest: unknown[]) => boolean;
        stopEvent?: (e: Event) => boolean;
      };
      let node = props.node;
      const dom = view.dom;
      dom.classList.add("dc-pic");
      const img = dom.querySelector("img");
      const where = () => (typeof props.getPos === "function" ? props.getPos() : undefined);

      // Word's Layout Options: the small button beside a selected picture.
      const layout = h("button", {
        class: "dc-pic-layout", type: "button", contenteditable: "false", title: "Layout Options", "aria-label": "Layout Options",
        onclick: () => {
          const r = layout.getBoundingClientRect();
          openMenu(r.right + 4, r.top, wrapItems(node.attrs.wrap as Wrap, (wrap) => setLayout(editor, { wrap }, where())));
        },
      }, icon("wrapSquare", 15));
      // Beside the picture itself (its box, not the whole line a Top and Bottom picture takes).
      (img?.parentElement ?? dom).append(layout);

      const sync = (n: PmNode) => {
        // The resizable view sizes the picture only when it's made; sizes set from the ribbon come here.
        if (img) {
          img.style.width = n.attrs.width ? `${n.attrs.width}px` : "";
          img.style.height = n.attrs.height ? `${n.attrs.height}px` : "";
        }
        dom.dataset.wrap = n.attrs.wrap;
        dom.dataset.align = n.attrs.align;
        dom.style.left = isFree(n.attrs.wrap) ? `${n.attrs.x}px` : "";
        dom.style.top = isFree(n.attrs.wrap) ? `${n.attrs.y}px` : "";
      };
      sync(node);
      const update = view.update?.bind(view);
      view.update = (n, ...rest) => {
        const ok = update ? update(n, ...rest) : n.type === node.type;
        if (ok) {
          node = n;
          sync(n);
        }
        return ok;
      };

      // Behind or in front of the text, a picture moves where it's dragged.
      img?.addEventListener("pointerdown", (e) => {
        if (!isFree(node.attrs.wrap) || e.button !== 0 || !editor.isEditable) return;
        e.preventDefault();
        const pos = where();
        if (pos === undefined) return;
        editor.commands.setNodeSelection(pos);
        // The page may be zoomed: pointer pixels to the picture's own pixels.
        const scale = dom.getBoundingClientRect().width / (dom.offsetWidth || 1) || 1;
        const start = { x: e.clientX, y: e.clientY, left: Number(node.attrs.x) || 0, top: Number(node.attrs.y) || 0 };
        let moved = { x: start.left, y: start.top };
        img.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          moved = { x: Math.round(start.left + (ev.clientX - start.x) / scale), y: Math.round(start.top + (ev.clientY - start.y) / scale) };
          dom.style.left = `${moved.x}px`;
          dom.style.top = `${moved.y}px`;
        };
        const up = () => {
          img.removeEventListener("pointermove", move);
          img.removeEventListener("pointerup", up);
          img.removeEventListener("pointercancel", up);
          if (moved.x !== start.left || moved.y !== start.top) setLayout(editor, { x: moved.x, y: moved.y }, where());
        };
        img.addEventListener("pointermove", move);
        img.addEventListener("pointerup", up);
        img.addEventListener("pointercancel", up);
      });

      const stop = view.stopEvent?.bind(view);
      view.stopEvent = (e: Event) => {
        const target = e.target as Node | null;
        if (target && layout.contains(target)) return true;
        // The editor mustn't start its own drag of a free picture (the move above does it).
        if (isFree(node.attrs.wrap) && target === img && (e.type === "mousedown" || e.type === "dragstart")) return true;
        return stop ? stop(e) : false;
      };
      return view as never;
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      // Arrow keys nudge a selected free picture (Shift: ten pixels), as in Word.
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const sel = view.state.selection;
            if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image" || !isFree(sel.node.attrs.wrap)) return false;
            const step = event.shiftKey ? 10 : 1;
            const delta = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key];
            if (!delta) return false;
            const attrs = { ...sel.node.attrs, x: (Number(sel.node.attrs.x) || 0) + delta[0], y: (Number(sel.node.attrs.y) || 0) + delta[1] };
            const tr = view.state.tr.setNodeMarkup(sel.from, undefined, attrs);
            view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, sel.from)));
            return true;
          },
        },
      }),
    ];
  },
});

/** Changes the picture at `pos` (the selected one when not given) and keeps it selected. */
export function setLayout(editor: Editor, attrs: Partial<{ wrap: Wrap; align: Align; x: number; y: number; width: number; height: number; src: string; alt: string }>, pos?: number) {
  const sel = editor.state.selection;
  const at = pos ?? (sel instanceof NodeSelection ? sel.from : undefined);
  if (at === undefined) return;
  const next: Record<string, unknown> = { ...attrs };
  // Back in the flow of text, a picture forgets where it was on the page.
  if (attrs.wrap && !isFree(attrs.wrap)) Object.assign(next, { x: 0, y: 0 });
  // The page stays where it was (giving the editor its focus back from a menu may scroll it).
  const desk = editor.view.dom.closest<HTMLElement>(".dc-desk");
  const top = desk?.scrollTop ?? 0;
  // The picture stays selected, as in Word, so its tab and handles stay.
  editor.chain().focus().setNodeSelection(at).updateAttributes("image", next).setNodeSelection(at).run();
  if (desk) {
    desk.scrollTop = top;
    requestAnimationFrame(() => (desk.scrollTop = top));
  }
}

/** The selected picture's attributes, or null when no picture is selected. */
export function selectedPicture(editor: Editor): Record<string, unknown> | null {
  const sel = editor.state.selection;
  return sel instanceof NodeSelection && sel.node.type.name === "image" ? sel.node.attrs : null;
}

/** Turns a picture's pixels (rotation and flips are kept in the picture, so every app sees them). */
export async function transformPicture(src: string, how: "right" | "left" | "flipH" | "flipV"): Promise<{ src: string; turned: boolean } | null> {
  const img = new window.Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const turned = how === "right" || how === "left";
  const w = img.naturalWidth, hgt = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = turned ? hgt : w;
  canvas.height = turned ? w : hgt;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.translate(canvas.width / 2, canvas.height / 2);
  if (how === "right") g.rotate(Math.PI / 2);
  else if (how === "left") g.rotate(-Math.PI / 2);
  else if (how === "flipH") g.scale(-1, 1);
  else g.scale(1, -1);
  g.drawImage(img, -w / 2, -hgt / 2);
  // JPEGs stay JPEG; everything else (PNG, GIF, WebP, SVG) becomes a PNG.
  const jpeg = /^data:image\/jpe?g/i.test(src);
  return { src: canvas.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.92), turned };
}

/**
 * Lays pictures out in HTML for printing and saving (outside the editor the picture is a bare
 * <img>): wrapping becomes floats and margins, free pictures absolute positions in their
 * paragraph. For a .docx, Top and Bottom becomes a paragraph of its own, and pictures behind or
 * in front of the text are saved as Square, which `warn` reports.
 */
export function layoutPictures(root: ParentNode, docx = false, warn?: (text: string) => void) {
  let free = 0;
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-wrap]"))) {
    const wrap = img.getAttribute("data-wrap") as Wrap;
    const align = (img.getAttribute("data-align") as Align | null) ?? "left";
    const s = img.style;
    if (wrap === "square" && align !== "center") {
      s.float = align;
      s.margin = align === "left" ? "2pt 12pt 6pt 0" : "2pt 0 6pt 12pt";
    } else if (wrap === "square" || wrap === "topBottom") {
      if (docx) {
        const p = document.createElement("p");
        p.style.textAlign = align;
        img.closest("p, h1, h2, h3, h4, h5, h6, li")?.before(p);
        p.append(img);
      } else {
        s.display = "block";
        s.margin = `6pt ${align === "right" ? "0" : "auto"} 6pt ${align === "left" ? "0" : "auto"}`;
      }
    } else if (isFree(wrap)) {
      if (docx) {
        free++;
        s.float = "left";
        s.margin = "2pt 12pt 6pt 0";
      } else {
        const p = img.parentElement;
        if (p) p.style.position = "relative";
        s.position = "absolute";
        s.left = `${Number(img.getAttribute("data-x")) || 0}px`;
        s.top = `${Number(img.getAttribute("data-y")) || 0}px`;
        s.zIndex = wrap === "behind" ? "-1" : "2";
      }
    }
  }
  if (free && warn) warn(`${free === 1 ? "A picture" : `${free} pictures`} behind or in front of the text ${free === 1 ? "was" : "were"} saved with Square wrapping.`);
}
