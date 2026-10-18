import { tileUrl } from "../../../api";

export interface Tile {
  /** Position and size in image pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The RGBA data includes a 1-pixel apron; the tile starts at (offX, offY) inside it. */
  dataW: number;
  dataH: number;
  offX: number;
  offY: number;
  data: Uint8Array;
}

const TILE_SIZE = 512;
const MAX_IN_FLIGHT = 4;
const MAX_CACHED = 140;

/**
 * The full-resolution photo as lossless tiles decoded by the backend. Only tiles on screen
 * are fetched, so huge photos never have to be decoded or uploaded in one go.
 */
export class TiledImage {
  readonly tileSize = TILE_SIZE;
  readonly cols: number;
  readonly rows: number;
  /** Called whenever a tile arrives. */
  onLoad: () => void = () => {};
  private tiles = new Map<number, Tile>();
  private loading = new Set<number>();
  private queue: number[] = [];
  private disposed = false;

  constructor(readonly path: string, readonly mtime: number, readonly width: number, readonly height: number) {
    this.cols = Math.ceil(width / TILE_SIZE);
    this.rows = Math.ceil(height / TILE_SIZE);
  }

  get(tx: number, ty: number): Tile | undefined {
    const key = this.key(tx, ty);
    const tile = this.tiles.get(key);
    if (tile) {
      // Most recently used last, for eviction.
      this.tiles.delete(key);
      this.tiles.set(key, tile);
    }
    return tile;
  }

  /** Replaces the wanted list (nearest the viewport centre first) and starts fetching. */
  want(cells: [number, number][]) {
    this.queue = cells.map(([x, y]) => this.key(x, y)).filter((k) => !this.tiles.has(k) && !this.loading.has(k));
    this.pump();
  }

  /** The colour of an image pixel, if its tile is loaded. */
  pixel(x: number, y: number): [number, number, number] | null {
    const tile = this.tiles.get(this.key(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE)));
    if (!tile) return null;
    const i = ((y - tile.y + tile.offY) * tile.dataW + (x - tile.x + tile.offX)) * 4;
    return [tile.data[i], tile.data[i + 1], tile.data[i + 2]];
  }

  dispose() {
    this.disposed = true;
    this.tiles.clear();
    this.queue = [];
  }

  private key(tx: number, ty: number) {
    return ty * this.cols + tx;
  }

  private pump() {
    while (this.loading.size < MAX_IN_FLIGHT && this.queue.length) {
      const key = this.queue.shift()!;
      if (this.tiles.has(key) || this.loading.has(key)) continue;
      this.loading.add(key);
      void this.fetchTile(key).finally(() => {
        this.loading.delete(key);
        if (!this.disposed) this.pump();
      });
    }
  }

  private async fetchTile(key: number) {
    const tx = key % this.cols;
    const ty = Math.floor(key / this.cols);
    try {
      const response = await fetch(tileUrl(this.path, this.mtime, tx, ty, TILE_SIZE));
      if (!response.ok) return;
      const buffer = await response.arrayBuffer();
      if (this.disposed) return;
      const header = new DataView(buffer, 0, 16);
      const [dataW, dataH, offX, offY] = [0, 4, 8, 12].map((o) => header.getUint32(o, true));
      const x = tx * TILE_SIZE;
      const y = ty * TILE_SIZE;
      this.tiles.set(key, {
        x, y, w: Math.min(TILE_SIZE, this.width - x), h: Math.min(TILE_SIZE, this.height - y),
        dataW, dataH, offX, offY, data: new Uint8Array(buffer, 16),
      });
      while (this.tiles.size > MAX_CACHED) this.tiles.delete(this.tiles.keys().next().value!);
      this.onLoad();
    } catch {
      // Not fatal: the preview stays visible under a missing tile.
    }
  }
}
