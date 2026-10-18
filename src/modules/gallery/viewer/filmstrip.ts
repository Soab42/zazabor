import type { Photo } from "../library/model";
import { photoThumbUrl, type ThumbLoader } from "../../../shared/thumbs";
import { h, rafThrottle } from "../../../ui/dom";

const ITEM = 78;
const THUMB = 62;
const OVERSCAN = 6;

/** A horizontally scrolling, virtualized strip of thumbnails for the viewer. */
export class Filmstrip {
  readonly el = h("div", { class: "film" });
  private track = h("div", { class: "film-track" });
  private photos: Photo[] = [];
  private current = -1;
  private nodes = new Map<number, HTMLElement>();

  constructor(private readonly thumbs: ThumbLoader, private readonly onSelect: (index: number) => void) {
    this.el.append(this.track);
    this.el.addEventListener("scroll", rafThrottle(() => this.render()), { passive: true });
    this.el.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      }
    }, { passive: false });
    this.el.addEventListener("click", (e) => {
      const item = e.target instanceof Element ? e.target.closest<HTMLElement>(".film-item") : null;
      if (item?.dataset.index) this.onSelect(Number(item.dataset.index));
    });
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  setPhotos(photos: Photo[]) {
    this.photos = photos;
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.current = -1;
  }

  setCurrent(index: number) {
    const previous = this.current;
    this.current = index;
    this.nodes.get(previous)?.classList.remove("current");
    this.nodes.get(index)?.classList.add("current");
    this.render();
    const far = previous < 0 || Math.abs(previous - index) > 12;
    this.el.scrollTo({ left: index * ITEM + ITEM / 2, behavior: far ? "auto" : "smooth" });
  }

  private render() {
    // Half a strip of padding on each side lets the first and last items reach the center.
    const pad = this.el.clientWidth / 2;
    this.track.style.width = `${this.photos.length * ITEM + pad * 2}px`;
    for (const [index, node] of this.nodes) node.style.transform = `translateX(${pad + index * ITEM}px)`;
    const first = Math.max(0, Math.floor((this.el.scrollLeft - pad) / ITEM) - OVERSCAN);
    const last = Math.min(this.photos.length - 1, Math.ceil((this.el.scrollLeft + this.el.clientWidth - pad) / ITEM) + OVERSCAN);
    for (const [index, node] of this.nodes) {
      if (index >= first && index <= last) continue;
      this.thumbs.cancel(node.querySelector("img")!);
      node.remove();
      this.nodes.delete(index);
    }
    for (let i = first; i <= last; i++) {
      if (this.nodes.has(i)) continue;
      const photo = this.photos[i];
      const img = h("img", { alt: "", draggable: false });
      const node = h("div", { class: `film-item${i === this.current ? " current" : ""}`, title: photo.name }, img);
      node.dataset.index = String(i);
      node.style.transform = `translateX(${pad + i * ITEM}px)`;
      this.track.append(node);
      this.nodes.set(i, node);
      this.thumbs.load(img, photoThumbUrl(photo, THUMB));
    }
  }
}
