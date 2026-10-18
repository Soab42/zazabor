import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { infoApi, TAG_COLORS } from "../info-api";
import { tagStore } from "./tagstore";

/** How many of the targeted items carry a tag. */
export type TagState = "none" | "some" | "all";

/** The current tags of each path (missing paths have none). */
export const loadTags = (paths: string[]) => infoApi.tagsGet(paths);

/** Which of the colours the paths carry: all of them, some, or none. */
export function tagStates(paths: string[], tags: Record<string, string[]>): Map<string, TagState> {
  const states = new Map<string, TagState>();
  for (const { name } of TAG_COLORS) {
    const count = paths.filter((p) => tags[p]?.includes(name)).length;
    states.set(name, count === 0 ? "none" : count === paths.length ? "all" : "some");
  }
  return states;
}

/**
 * Toggles a colour on every path: removed from all when all have it, otherwise added to all.
 * Other tags (those not in the palette) are preserved. Resolves with the new tags per path.
 */
export async function toggleTag(paths: string[], tag: string, current: Record<string, string[]>): Promise<Record<string, string[]>> {
  const remove = paths.every((p) => current[p]?.includes(tag));
  const next: Record<string, string[]> = { ...current };
  for (const path of paths) {
    const had = current[path] ?? [];
    const tags = remove ? had.filter((t) => t !== tag) : had.includes(tag) ? had : [...had, tag];
    await infoApi.tagsSet(path, tags);
    tagStore.set(path, tags);
    if (tags.length) next[path] = tags;
    else delete next[path];
  }
  return next;
}

/** A colour dot in the tag's colour; `size` is in CSS pixels. */
export function tagDot(name: string, size = 10): HTMLElement {
  const color = TAG_COLORS.find((t) => t.name === name)?.css ?? "var(--tag-grey)";
  return h("span", { class: "tag-dot", style: { width: `${size}px`, height: `${size}px`, background: color } });
}

let openPopover: { el: HTMLElement; close: () => void } | null = null;

/** Closes the tag popover if one is open. */
export function closeTagPopover() {
  openPopover?.close();
}

/**
 * A small glass popover of colour dots at a screen position that toggles tags on `paths`.
 * `onChange` gets the new tags after every toggle.
 */
export function openTagPopover(x: number, y: number, paths: string[], onChange?: (tags: Record<string, string[]>) => void) {
  closeTagPopover();
  let tags: Record<string, string[]> = {};
  const caption = h("div", { class: "tag-pop-caption" }, paths.length > 1 ? `${paths.length} items` : "Tags");
  const dots = TAG_COLORS.map(({ name, css }) => {
    const button = h("button", { class: "tag-pick", title: name, "aria-label": name, "aria-pressed": "false" },
      h("span", { class: "tag-pick-dot", style: { background: css } }, icon("check", 11)));
    button.addEventListener("mouseenter", () => { caption.textContent = name; });
    button.addEventListener("focus", () => { caption.textContent = name; });
    button.addEventListener("click", () => {
      toggleTag(paths, name, tags).then((next) => {
        tags = next;
        paint();
        onChange?.(tags);
      }).catch((e) => {
        caption.textContent = String(e).replace(/^Error: /, "");
        caption.classList.add("error");
      });
    });
    return { name, button };
  });
  const paint = () => {
    const states = tagStates(paths, tags);
    for (const { name, button } of dots) {
      const state = states.get(name) ?? "none";
      button.dataset.state = state;
      button.setAttribute("aria-pressed", String(state === "all"));
    }
  };
  const el = h("div", { class: "tag-pop glass-strong", role: "dialog", "aria-label": "Tags" },
    h("div", { class: "tag-pop-row" }, ...dots.map((d) => d.button)), caption);
  document.body.append(el);
  const left = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8));
  const top = Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.setProperty("--origin-x", `${x - left}px`);
  el.style.setProperty("--origin-y", `${y - top}px`);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  const onPointer = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("blur", close);
    el.remove();
    if (openPopover?.el === el) openPopover = null;
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("blur", close);
  openPopover = { el, close };
  dots[0].button.focus();

  // Toggling needs the current tags, so the dots wait for them.
  el.classList.add("busy");
  loadTags(paths).then((loaded) => {
    if (openPopover?.el !== el) return;
    tags = loaded;
  }).catch(() => {}).finally(() => {
    el.classList.remove("busy");
    paint();
  });
  paint();
}
