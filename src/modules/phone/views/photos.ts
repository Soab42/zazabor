import { open as openDialog } from "../../../shared/dialog";
import { formatBytes, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { showToast } from "../../files/ops/toast";
import { duration, errorText, hasCap, phoneApi, type Photo } from "../api";
import type { PhoneCtx, PhoneView } from "../ctx";
import { emptyState, loadingState } from "../ui";

const PAGE = 60;

/**
 * Photos: the phone's recent pictures and videos, newest first. Click opens a preview; Save (or
 * Save To…) copies the original to this PC. Ctrl-click and Shift-click pick several.
 */
export function photosView(ctx: PhoneCtx): PhoneView {
  let photos: Photo[] = [];
  let more = true;
  let loading = false;
  let failed: string | null = null;
  const selected = new Set<number>();
  let anchor = -1;

  const count = h("span", { class: "pl-count" });
  const saveSelected = h("button", { class: "btn small", type: "button", hidden: true }, icon("download", 14), "Save");
  saveSelected.addEventListener("click", () => void save(photos.filter((p) => selected.has(p.id))));
  const clearSel = h("button", { class: "btn small ghost", type: "button", hidden: true }, "Clear");
  clearSel.addEventListener("click", () => {
    selected.clear();
    drawSelection();
  });
  const refresh = h("button", { class: "icon-btn", type: "button", title: "Refresh", "aria-label": "Refresh" }, icon("refresh", 16));
  refresh.addEventListener("click", () => void reload());
  const grid = h("div", { class: "pl-photo-grid" });
  const foot = h("div", { class: "pl-photo-foot" });
  const scroller = h("div", { class: "pl-photo-scroll" }, grid, foot);
  scroller.addEventListener("scroll", () => {
    if (more && !loading && scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 600) void loadMore();
  });
  const el = h("div", { class: "pl-pane pl-photos" },
    h("header", { class: "pl-bar" }, h("div", { class: "pl-bar-row" }, h("h1", { class: "pl-title" }, "Photos"), count, h("span", { class: "spacer" }), clearSel, saveSelected, refresh)),
    scroller);

  const phoneId = () => ctx.phone()?.phoneId ?? "";

  async function loadMore() {
    const id = phoneId();
    if (!id || loading) return;
    loading = true;
    drawFoot();
    try {
      const next = await phoneApi.photos(id, photos.length, PAGE);
      if (id !== phoneId()) return;
      const known = new Set(photos.map((p) => p.id));
      const fresh = next.filter((p) => !known.has(p.id));
      photos.push(...fresh);
      more = next.length >= PAGE;
      failed = null;
      appendTiles(fresh, photos.length - fresh.length);
    } catch (err) {
      failed = errorText(err);
      more = false;
    } finally {
      loading = false;
      drawFoot();
    }
  }

  async function reload() {
    photos = [];
    more = true;
    selected.clear();
    grid.replaceChildren();
    drawSelection();
    await loadMore();
  }

  function drawFoot() {
    count.textContent = photos.length ? `${photos.length}${more ? "+" : ""}` : "";
    foot.replaceChildren();
    const phone = ctx.phone();
    if (!photos.length && loading) return foot.append(loadingState("Loading photos…"));
    if (!photos.length && !hasCap(phone, "photos")) return foot.append(emptyState("image", "Photos aren't shared", "Allow Zazabor Link to see your photos and videos on the phone."));
    if (!photos.length && !phone?.connected) return foot.append(emptyState("image", "The phone isn't connected", "Photos show while the phone is linked to this PC."));
    if (!photos.length && failed) return foot.append(emptyState("image", "Couldn't load photos", failed));
    if (!photos.length) return foot.append(emptyState("image", "No photos", "Pictures and videos on the phone show up here."));
    if (loading) foot.append(h("span", { class: "spinner" }));
  }

  function appendTiles(list: Photo[], start: number) {
    grid.append(...list.map((p, i) => {
      const index = start + i;
      const tile = h("button", { class: "pl-photo", type: "button", title: `${p.name}\n${new Date(p.at).toLocaleString()}`, "data-id": String(p.id) },
        h("img", { src: p.thumb, alt: p.name, loading: "lazy", decoding: "async", draggable: false }),
        p.video ? h("span", { class: "pl-photo-video" }, icon("play", 10), p.duration ? duration(p.duration) : "") : null,
        h("span", { class: "pl-photo-tick" }, icon("check", 12)));
      tile.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (selected.has(p.id)) selected.delete(p.id);
          else selected.add(p.id);
          anchor = index;
        } else if (e.shiftKey && anchor >= 0) {
          const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
          for (let k = a; k <= b; k++) selected.add(photos[k].id);
        } else if (selected.size) {
          selected.clear();
          selected.add(p.id);
          anchor = index;
        } else {
          anchor = index;
          preview(index);
          return;
        }
        drawSelection();
      });
      return tile;
    }));
  }

  function drawSelection() {
    for (const tile of grid.querySelectorAll<HTMLElement>(".pl-photo")) tile.classList.toggle("selected", selected.has(Number(tile.dataset.id)));
    saveSelected.hidden = clearSel.hidden = selected.size === 0;
    saveSelected.lastChild!.textContent = selected.size > 1 ? `Save ${selected.size}` : "Save";
  }

  async function save(list: Photo[], ask = false) {
    if (!list.length) return;
    let dest = ctx.downloadDir();
    if (ask) {
      const chosen = await openDialog({ title: "Save to", directory: true, defaultPath: dest || undefined });
      if (!chosen) return;
      dest = chosen;
    }
    try {
      await phoneApi.download(phoneId(), list.map((p) => p.uri), dest);
      ctx.showTransfers();
    } catch (err) {
      showToast(`Couldn't save: ${errorText(err)}`);
    }
  }

  // ---- the preview

  function preview(start: number) {
    let index = start;
    const img = h("img", { class: "pl-preview-img", alt: "" });
    const title = h("strong", { class: "pl-preview-name" });
    const info = h("span", { class: "pl-preview-info" });
    const prev = h("button", { class: "pl-preview-nav prev", type: "button", "aria-label": "Previous" }, icon("chevronLeft", 22));
    const next = h("button", { class: "pl-preview-nav next", type: "button", "aria-label": "Next" }, icon("chevronRight", 22));
    const saveButton = h("button", { class: "btn primary small", type: "button" }, icon("download", 14), "Save");
    const saveAs = h("button", { class: "btn small", type: "button" }, "Save To…");
    const close = h("button", { class: "icon-btn", type: "button", title: "Close (Esc)", "aria-label": "Close" }, icon("close", 18));
    const overlay = h("div", { class: "pl-preview", role: "dialog", "aria-modal": "true", "aria-label": "Photo", tabIndex: -1 },
      h("header", { class: "pl-preview-bar glass" }, h("div", { class: "pl-preview-titles" }, title, info), h("span", { class: "spacer" }), saveAs, saveButton, close),
      h("div", { class: "pl-preview-stage" }, img, prev, next));
    const show = () => {
      const p = photos[index];
      img.src = p.thumb;
      img.alt = p.name;
      title.textContent = p.name;
      const bits = [new Date(p.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), p.width && p.height ? `${p.width} × ${p.height}` : "", formatBytes(p.size), p.video && p.duration ? duration(p.duration) : ""];
      info.textContent = bits.filter(Boolean).join(" · ");
      prev.disabled = index === 0;
      next.disabled = index >= photos.length - 1;
      // Near the end: fetch the next page so → keeps going.
      if (index > photos.length - 6 && more) void loadMore().then(() => (next.disabled = index >= photos.length - 1));
    };
    const step = (d: number) => {
      const to = index + d;
      if (to < 0 || to >= photos.length) return;
      index = to;
      show();
    };
    const done = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") void save([photos[index]]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    prev.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    close.addEventListener("click", done);
    saveButton.addEventListener("click", () => void save([photos[index]]));
    saveAs.addEventListener("click", () => void save([photos[index]], true));
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay || (e.target as HTMLElement).classList.contains("pl-preview-stage")) done();
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    show();
    overlay.focus();
  }

  let shownFor = "";
  return {
    el,
    show(phoneChanged) {
      const id = phoneId();
      if (id !== shownFor || (phoneChanged && !photos.length)) {
        shownFor = id;
        void reload();
      } else {
        drawFoot();
      }
    },
    handleKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && photos.length) {
        for (const p of photos) selected.add(p.id);
        drawSelection();
        return true;
      }
      if (e.key === "Escape" && selected.size) {
        selected.clear();
        drawSelection();
        return true;
      }
      if (e.key === "F5") {
        void reload();
        return true;
      }
      return false;
    },
  };
}
