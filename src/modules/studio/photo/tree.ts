import type { Layer } from "./engine";

/**
 * Groups in Photo's flat layer list: a group sits right above (after) its layers, which name it
 * as their `parent`. A layer and everything inside it make a contiguous block ending at the
 * layer itself; these helpers keep it that way.
 */

/** The block of the layer at `index` (itself and, for a group, every layer inside): [start, index]. */
export function blockOf(layers: Layer[], index: number): [number, number] {
  const layer = layers[index];
  if (!layer || layer.kind !== "group") return [index, index];
  let start = index;
  while (start > 0 && isInside(layers, layers[start - 1], layer.id)) start--;
  return [start, index];
}

/** Whether `layer` is inside the group `groupId`, at any depth. */
export function isInside(layers: Layer[], layer: Layer, groupId: number): boolean {
  let parent = layer.parent;
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (let guard = 0; parent !== null && guard < 1000; guard++) {
    if (parent === groupId) return true;
    parent = byId.get(parent)?.parent ?? null;
  }
  return false;
}

/** How deep a layer sits: 0 at the top, 1 inside one group… */
export function depthOf(layers: Layer[], layer: Layer): number {
  const byId = new Map(layers.map((l) => [l.id, l]));
  let depth = 0;
  for (let parent = layer.parent; parent !== null && depth < 1000; depth++) parent = byId.get(parent)?.parent ?? null;
  return depth;
}

/** Whether a layer is hidden by a closed group above it in the Layers panel. */
export function isFolded(layers: Layer[], layer: Layer): boolean {
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (let parent = layer.parent, guard = 0; parent !== null && guard < 1000; guard++) {
    const group = byId.get(parent);
    if (!group) return false;
    if (group.kind === "group" && !group.open) return true;
    parent = group.parent;
  }
  return false;
}

/** Whether a layer shows: it and every group it's in are visible. */
export function isShown(layers: Layer[], layer: Layer): boolean {
  if (!layer.visible) return false;
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (let parent = layer.parent, guard = 0; parent !== null && guard < 1000; guard++) {
    const group = byId.get(parent);
    if (!group) return true;
    if (!group.visible) return false;
    parent = group.parent;
  }
  return true;
}

/**
 * Moves the block of the layer at `from` so it lands at array position `at` (counted in the
 * list before the move), inside `parent`. Returns the new list and the layer's new index, or
 * null when the move makes no sense (a group into itself).
 */
export function moveBlock(layers: Layer[], from: number, at: number, parent: number | null): { layers: Layer[]; index: number } | null {
  const [start, end] = blockOf(layers, from);
  const layer = layers[from];
  if (parent !== null && (parent === layer.id || (layer.kind === "group" && isInsideId(layers, parent, layer.id)))) return null;
  if (at > start && at <= end + 1) at = start;
  const block = layers.slice(start, end + 1);
  const rest = [...layers.slice(0, start), ...layers.slice(end + 1)];
  const pos = at > end ? at - block.length : at;
  rest.splice(pos, 0, ...block);
  layer.parent = parent;
  return { layers: rest, index: pos + block.length - 1 };
}

function isInsideId(layers: Layer[], id: number, groupId: number): boolean {
  const layer = layers.find((l) => l.id === id);
  return !!layer && isInside(layers, layer, groupId);
}

/** The layers sharing a parent with `layer`, bottom first, as array indices of their blocks' tops. */
export function siblings(layers: Layer[], parent: number | null): number[] {
  const out: number[] = [];
  layers.forEach((l, i) => {
    if (l.parent === parent) out.push(i);
  });
  return out;
}

/** Every layer inside a group (any depth), bottom first. */
export function descendants(layers: Layer[], index: number): Layer[] {
  const [start, end] = blockOf(layers, index);
  return layers.slice(start, end);
}
