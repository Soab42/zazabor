import type { Key } from "../ease";
import type { BackgroundLayer, FxLayer, GroupLayer, Layer, Paint, RectLayer } from "../format";
import type { Responsive } from "../layout";
import { FULL } from "./build";

/**
 * The signature moves of the rule book's category playbooks (motion-rulebook.md §12), as pieces
 * the launch, sale, feature and app templates share: what makes each category look made by hand.
 */

// ---- launch: the product rises from darkness, a rim light sweeps it, a fast push eases into a slow drift

/**
 * A veil of the base colour over the product that lifts as it rises (from `t0`, gone by `t1`);
 * `peak` under 1 when the product is frame 0's hook, so the thumbnail still shows it.
 */
export function darkness(id: string, fr: Responsive, t0: number, t1: number, peak = 1): RectLayer {
  return {
    id, kind: "ellipse", frame: fr, scale: 1.9, time: [0, t1 + 0.05],
    fill: { kind: "radial", stops: [[0, "@bg/0.9"], [0.3, "@bg/0.78"], [0.6, "@bg/0.36"], [0.82, "@bg/0.1"], [1, "@bg/0"]] },
    opacity: [[t0, peak, "inOut"], [t1, 0]],
  };
}

/** A narrow rim light sweeping across, starting at `t`. */
export const rimLight = (t: number, strength = 0.85) => ({ at: [[t, -0.2, "inOut"], [t + 0.75, 1.2]] as Key[], width: 0.07, angle: 72, strength });

/**
 * Scale for the product: in from `from` on a spring at `t0` (whole by `t0 + din`), the camera's
 * fast push at `push` (600 ms, to `k`), then held for the idle drift, and out at `exit`.
 */
export function pushIn(t0: number, from: number, din: number, push: number, exit: number, k = 1.05, to = 0.92): Key[] {
  return [[t0, from, "spring"], [t0 + din, 1], [push, 1, "out"], [push + 0.6, k], [exit, k, "in"], [exit + 0.35, k * to]];
}

// ---- sale: the number slams down with overshoot, confetti fires on the settle frame

/**
 * Scale for a slam landing at `t`: three frames winding up, a hard landing with a 6% squash, the
 * overshoot settling on a spring, and out at `exit`.
 */
export function slam(t: number, exit?: number, to = 0.85): Key[] {
  const keys: Key[] = [[t - 0.32, 1.7, "out"], [t - 0.22, 1.82, "in"], [t, 0.94, "spring"], [t + 0.55, 1]];
  if (exit !== undefined) keys.push([exit, 1, "in"], [exit + 0.3, to]);
  return keys;
}

/** Opacity for a slam landing at `t` (and out at `exit`). */
export const slamIn = (t: number, exit: number): Key[] => [[t - 0.32, 0, "out"], [t - 0.26, 1], [exit, 1, "in"], [exit + 0.3, 0]];

/** Confetti on the frame a slam at `t` settles. */
export const settleConfetti = (id: string, t: number, amount = 0.8, fr: Responsive = FULL): FxLayer => ({ id, kind: "fx", fx: "confetti", frame: fr, burst: t + 0.14, amount });

// ---- feature: the card just read becomes the next scene's frame

/**
 * A copy of the card at `fr` that, as everything else leaves at `exit`, takes in what was on it
 * and grows `k` times, enough to fill the frame.
 */
export function handoff(id: string, fr: Responsive, exit: number, k: number, fill: Paint = "@card", radius: RectLayer["radius"] = "theme"): RectLayer {
  return {
    id, kind: "rect", frame: fr, fill, radius, time: [exit, exit + 3],
    opacity: [[exit, 0, "out"], [exit + 0.3, 1]], scale: [[exit + 0.1, 1, "inOut"], [exit + 0.6, k]],
  };
}

// ---- app: zoom through the screen into full-frame UI, one glass card refracting the live background

/** Scale for a device that zooms through its screen at `exit` (after `keys`, which end at `from`), to `k` times. */
export const zoomThrough = (keys: Key[], exit: number, k = 7, from = 1): Key[] => [...keys, [exit, from, "in"], [exit + 0.55, from * k]];

/**
 * A card of glass at `fr`: the live background `bg` seen through it, magnified and shifted (the
 * refraction), frosted, with a bright rim and a sheen; in at `t`, out at `exit`.
 */
export function glassCard(id: string, fr: Responsive, bg: BackgroundLayer, t: number, exit: number): GroupLayer {
  const seen: Layer = { ...bg, id: `${id}-seen`, frame: FULL, over: false, scale: 1.14, dx: -0.03, dy: 0.02, vignette: 0 };
  return {
    id, kind: "group", frame: fr, clip: "round",
    opacity: [[t, 0, "out"], [t + 0.4, 1], [exit, 1, "in"], [exit + 0.3, 0]], scale: [[t, 0.94, "out"], [t + 0.6, 1]],
    children: [
      seen,
      // Calmed toward the base colour (smoked on a dark look, milky on a light one), so text on it reads.
      { id: `${id}-calm`, kind: "rect", frame: fr, fill: "@bg/0.55" },
      { id: `${id}-frost`, kind: "rect", frame: fr, radius: "theme", fill: { kind: "linear", angle: 120, stops: [[0, "#ffffff/0.16"], [0.5, "#ffffff/0.04"], [1, "#ffffff/0.1"]] } },
      { id: `${id}-rim`, kind: "rect", frame: fr, radius: "theme", stroke: "#ffffff/0.5", strokeWidth: 0.0025, sheen: { at: [[t + 0.5, -0.2, "inOut"], [t + 1.6, 1.2]], width: 0.25, strength: 0.4 } },
    ],
  };
}
