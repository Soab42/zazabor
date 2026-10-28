/**
 * QR codes for motion templates (a download link, a shop's page), written for Zazabor from the QR
 * standard (ISO/IEC 18004): byte mode, error correction level M (15% of the code can be damaged),
 * versions 1–10, which is up to 213 bytes. Pure (tested in tools/motion.test.mjs, and checked by
 * decoding with OpenCV).
 */

/** Error-correction codewords per block, and blocks, at level M for versions 1–10. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const QR_MAX_VERSION = 10;

/** Modules the data and error correction fill in a version (everything but the fixed patterns). */
function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

/** Data codewords a version holds at level M. */
export function dataCapacity(ver: number): number {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];
}

/** Where alignment patterns' centres go (rows and columns). */
function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---- Reed–Solomon over GF(2^8) with the polynomial 0x11D

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

// ---- encoding

/** The smallest version that holds `bytes` in byte mode, or null when it's too long. */
export function versionFor(bytes: number): number | null {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes * 8 <= dataCapacity(v) * 8) return v;
  }
  return null;
}

/** The data codewords: mode, length, bytes, terminator and padding. */
function dataCodewords(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCapacity(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Splits the data into blocks, adds each block's error correction, and interleaves them. */
function withErrorCorrection(data: number[], ver: number): number[] {
  const blocks = BLOCKS[ver], ecc = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(ecc);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const n = shortLen - ecc + (i < short ? 0 : 1);
    const dat = data.slice(k, k + n);
    k += n;
    const block = [...dat, ...rsRemainder(dat, divisor)];
    // Short blocks get a placeholder where long ones have their last data byte.
    if (i < short) block.splice(n, 0, -1);
    parts.push(block);
  }
  const out: number[] = [];
  for (let i = 0; i < parts[0].length; i++) {
    for (const b of parts) if (b[i] !== -1) out.push(b[i]);
  }
  return out;
}

/** A QR code: `size` × `size` modules, true = dark. */
export interface QrCode {
  version: number;
  size: number;
  mask: number;
  modules: boolean[][];
}

/** The format bits (level M and the mask) with their BCH error correction. */
export function formatBits(mask: number): number {
  const data = (0 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

/** Encodes text (as UTF-8); null when it's longer than version 10 holds. */
export function encodeQr(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  const ver = versionFor(bytes.length);
  if (ver === null) return null;
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };
  // Timing patterns, then finders with their separators, then alignment patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(ver);
  align.forEach((ay, i) => align.forEach((ax, j) => {
    const last = align.length - 1;
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  // Reserve the format areas (written after the mask is chosen), and the version areas.
  const drawFormat = (mask: number) => {
    const bits = formatBits(mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  // The data, in the two-column zigzag from the bottom right.
  const codewords = withErrorCorrection(dataCodewords(bytes, ver), ver);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
  // The mask with the lowest penalty.
  const invert = (mask: number, x: number, y: number) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && invert(mask, x, y)) modules[y][x] = !modules[y][x];
  };
  let best = 0, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(modules);
    if (p < bestPenalty) {
      best = mask;
      bestPenalty = p;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return { version: ver, size, mask: best, modules };
}

/** The standard's penalty score (lower reads better). */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      const row: boolean[] = [];
      for (let j = 0; j < size; j++) {
        row.push(get(i, j));
        if (j > 0 && get(i, j) === get(i, j - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
      // 1:1:3:1:1 finder-like patterns with four light modules on one side.
      const s = row.map((d) => (d ? "1" : "0")).join("");
      for (let k = s.indexOf("1011101"); k >= 0; k = s.indexOf("1011101", k + 1)) {
        const before = s.slice(Math.max(0, k - 4), k), after = s.slice(k + 7, k + 11);
        if ((k >= 4 && before === "0000") || (after.length === 4 && after === "0000")) score += 40;
      }
    }
  };
  line((i, j) => m[i][j]);
  line((i, j) => m[j][i]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}
