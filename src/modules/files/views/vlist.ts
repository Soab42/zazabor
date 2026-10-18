import { clamp, h, rafThrottle } from "../../../ui/dom";

export interface VirtualListOptions {
  axis: "y" | "x";
  /** Extent of one item along the axis, in pixels. */
  size: number;
  /** Space before the first and after the last item. */
  pad?: number;
  /** Extra items kept rendered beyond each edge. */
  overscan?: number;
  create(): HTMLElement;
  bind(el: HTMLElement, index: number): void;
  /** An item left the rendered window; cancel anything it started. */
  release?(el: HTMLElement, index: number): void;
  onResize?(width: number, height: number): void;
}

/**
 * A fixed-item-size virtual scroller: only the items in (and just around) the viewport exist
 * as nodes, and nodes leaving the window are pooled and reused.
 */
export class VirtualList {
  /** The scroll container; put it where the list belongs. */
  readonly el = h("div", { class: "vl" });
  private space = h("div", { class: "vl-space" });
  private nodes = new Map<number, HTMLElement>();
  private pool: HTMLElement[] = [];
  private count = 0;
  private size: number;
  private readonly observer: ResizeObserver;

  constructor(private readonly opts: VirtualListOptions) {
    this.size = opts.size;
    this.el.classList.add(opts.axis === "y" ? "vl-y" : "vl-x");
    this.el.append(this.space);
    const onScroll = rafThrottle(() => this.render(false));
    this.el.addEventListener("scroll", onScroll, { passive: true });
    this.observer = new ResizeObserver(() => {
      opts.onResize?.(this.el.clientWidth, this.el.clientHeight);
      this.render(false);
    });
    this.observer.observe(this.el);
  }

  private get pad() {
    return this.opts.pad ?? 0;
  }

  private get vertical() {
    return this.opts.axis === "y";
  }

  get scroll() {
    return this.vertical ? this.el.scrollTop : this.el.scrollLeft;
  }

  set scroll(value: number) {
    if (this.vertical) this.el.scrollTop = value;
    else this.el.scrollLeft = value;
    this.render(false);
  }

  private get viewport() {
    return (this.vertical ? this.el.clientHeight : this.el.clientWidth) || (this.vertical ? 640 : 900);
  }

  /** Items visible to the user, for page-sized key steps. */
  get pageItems() {
    return Math.max(1, Math.floor(this.viewport / this.size));
  }

  setCount(count: number) {
    this.count = count;
    this.space.style[this.vertical ? "height" : "width"] = `${this.pad * 2 + count * this.size}px`;
    this.render(true);
  }

  setItemSize(size: number) {
    this.size = size;
    for (const node of this.nodes.values()) this.sizeNode(node);
    this.setCount(this.count);
  }

  /** Rebinds every rendered item after the data behind them changed. */
  refresh() {
    this.render(true);
  }

  nodeAt(index: number) {
    return this.nodes.get(index);
  }

  forEachRendered(fn: (el: HTMLElement, index: number) => void) {
    for (const [index, node] of this.nodes) fn(node, index);
  }

  /** Brings an item into view: the least scrolling that shows it, or centred. */
  scrollTo(index: number, align: "nearest" | "center" = "nearest") {
    const start = this.pad + index * this.size;
    const end = start + this.size;
    const view = this.viewport;
    const current = this.scroll;
    let target = current;
    if (align === "center") target = start - (view - this.size) / 2;
    else if (start - (index === 0 ? this.pad : 0) < current) target = start - (index === 0 ? this.pad : 0);
    else if (end + (index === this.count - 1 ? this.pad : 0) > current + view) target = end - view + (index === this.count - 1 ? this.pad : 0);
    if (target !== current) this.scroll = Math.max(0, target);
  }

  private sizeNode(node: HTMLElement) {
    node.style[this.vertical ? "height" : "width"] = `${this.size}px`;
  }

  private place(node: HTMLElement, index: number) {
    const offset = this.pad + index * this.size;
    node.style.transform = this.vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`;
  }

  private acquire() {
    const node = this.pool.pop() ?? this.opts.create();
    node.classList.add("vl-item");
    this.sizeNode(node);
    return node;
  }

  private render(force: boolean) {
    const { size, pad, count } = this;
    const overscan = this.opts.overscan ?? 4;
    const first = count === 0 ? 0 : clamp(Math.floor((this.scroll - pad) / size) - overscan, 0, count - 1);
    const last = count === 0 ? -1 : clamp(Math.ceil((this.scroll + this.viewport - pad) / size) + overscan, 0, count - 1);
    for (const [index, node] of this.nodes) {
      if (index >= first && index <= last) continue;
      this.opts.release?.(node, index);
      node.remove();
      this.pool.push(node);
      this.nodes.delete(index);
    }
    for (let i = first; i <= last; i++) {
      let node = this.nodes.get(i);
      if (node) {
        if (!force) continue;
      } else {
        node = this.acquire();
        this.nodes.set(i, node);
        this.space.append(node);
      }
      this.place(node, i);
      this.opts.bind(node, i);
    }
  }

  dispose() {
    this.observer.disconnect();
    for (const [index, node] of this.nodes) this.opts.release?.(node, index);
    this.nodes.clear();
    this.pool = [];
  }
}
