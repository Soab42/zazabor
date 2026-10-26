/**
 * .cube colour lookup tables (Adobe/Resolve's format): a 3D table of RGB values, red changing
 * fastest. 1D tables (LUT_1D_SIZE) are turned into the 3D table they stand for.
 */

export interface CubeLut {
  title: string;
  size: number;
  /** size³ RGB triples, red fastest, scaled to 0…1. */
  data: Float32Array;
}

/** The largest table accepted (65³ is the biggest common one). */
const MAX_SIZE = 65;

export function parseCube(text: string): CubeLut {
  let title = "";
  let size3 = 0, size1 = 0;
  let min = [0, 0, 0], max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "TITLE") title = line.slice(5).trim().replace(/^"|"$/g, "");
    else if (key === "LUT_3D_SIZE") size3 = Number(parts[1]);
    else if (key === "LUT_1D_SIZE") size1 = Number(parts[1]);
    else if (key === "DOMAIN_MIN") min = parts.slice(1, 4).map(Number);
    else if (key === "DOMAIN_MAX") max = parts.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(parts[0])) {
      if (parts.length < 3) throw new Error("A line of the table has fewer than three numbers.");
      values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    }
  }
  if (values.some((v) => !Number.isFinite(v))) throw new Error("The table has something that isn't a number.");
  const span = [0, 1, 2].map((i) => (max[i] - min[i]) || 1);
  const norm = (v: number, i: number) => (v - min[i]) / span[i];
  if (size3) {
    if (!Number.isInteger(size3) || size3 < 2 || size3 > MAX_SIZE) throw new Error(`LUT_3D_SIZE ${size3} isn't supported (2 to ${MAX_SIZE}).`);
    if (values.length !== size3 ** 3 * 3) throw new Error(`The table should have ${size3 ** 3} rows, not ${values.length / 3}.`);
    return { title, size: size3, data: Float32Array.from(values, (v, k) => norm(v, k % 3)) };
  }
  if (size1) {
    if (!Number.isInteger(size1) || size1 < 2 || size1 > 4096) throw new Error(`LUT_1D_SIZE ${size1} isn't supported.`);
    if (values.length !== size1 * 3) throw new Error(`The table should have ${size1} rows, not ${values.length / 3}.`);
    const n = 33;
    const curve = (channel: number, x: number) => {
      const p = x * (size1 - 1), i = Math.min(size1 - 2, Math.floor(p)), f = p - i;
      return norm(values[i * 3 + channel] * (1 - f) + values[(i + 1) * 3 + channel] * f, channel);
    };
    const data = new Float32Array(n ** 3 * 3);
    for (let b = 0, k = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, k += 3) {
      data[k] = curve(0, r / (n - 1));
      data[k + 1] = curve(1, g / (n - 1));
      data[k + 2] = curve(2, b / (n - 1));
    }
    return { title, size: n, data };
  }
  throw new Error("This isn't a .cube colour table (no LUT_3D_SIZE).");
}
