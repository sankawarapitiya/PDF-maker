/**
 * Pure image-processing routines used by the scanner.
 * Everything works on plain RGBA buffers so it runs in the browser,
 * in a Web Worker, or in Node (unit tests) alike.
 */

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Quad in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export type FilterName = 'original' | 'enhance' | 'gray' | 'bw';

export function createImg(width: number, height: number): Img {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function fullQuad(w: number, h: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

/** Luminance (0..255) per pixel. */
export function toGray(img: Img): Uint8ClampedArray {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return out;
}

/** Summed-area table (width+1)*(height+1) for O(1) box sums. */
export function integral(gray: ArrayLike<number>, width: number, height: number): Float64Array {
  const w1 = width + 1;
  const sat = new Float64Array(w1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x];
      sat[(y + 1) * w1 + x + 1] = sat[y * w1 + x + 1] + row;
    }
  }
  return sat;
}

/** Box blur with radius r using a summed-area table. */
export function boxBlur(gray: ArrayLike<number>, width: number, height: number, r: number): Float32Array {
  const sat = integral(gray, width, height);
  const w1 = width + 1;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width, x + r + 1);
      const sum = sat[y1 * w1 + x1] - sat[y0 * w1 + x1] - sat[y1 * w1 + x0] + sat[y0 * w1 + x0];
      out[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Otsu's method: threshold maximising between-class variance. */
export function otsu(gray: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.round(gray[i]) & 255]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

function polygonArea(q: Point[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** True if the quad is convex and wound consistently. */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Re-order four arbitrary points into TL, TR, BR, BL. */
export function orderQuad(pts: Point[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  // atan2 order starting from -PI goes: TL-ish, TR, BR, BL (y grows downwards)
  let start = 0;
  let bestSum = Infinity;
  sorted.forEach((p, i) => {
    if (p.x + p.y < bestSum) {
      bestSum = p.x + p.y;
      start = i;
    }
  });
  const q = [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  return q as Quad;
}

/**
 * Detect the outline of a document (a bright sheet on a darker background)
 * in a (preferably down-scaled, ~300px) image. Returns null when nothing
 * plausible is found. Coordinates are in the given image's pixel space.
 */
export function detectDocument(img: Img): Quad | null {
  const { width: w, height: h } = img;
  if (w < 8 || h < 8) return null;
  const gray = toGray(img);
  const blurred = boxBlur(gray, w, h, Math.max(1, Math.round(Math.min(w, h) / 100)));
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < blurred.length; i++) {
    if (blurred[i] < lo) lo = blurred[i];
    if (blurred[i] > hi) hi = blurred[i];
  }
  if (hi - lo < 30) return null; // no contrast: nothing to separate
  const t = otsu(blurred);

  // Foreground = brighter-than-threshold pixels.
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = blurred[i] > t ? 1 : 0;

  // Largest 4-connected component.
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0;
  let bestSize = 0;
  let label = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    label++;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = label;
    let size = 0;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
  }
  const total = w * h;
  if (bestSize < total * 0.1) return null;

  // Corner extremes: TL=min(x+y), BR=max(x+y), TR=max(x-y), BL=min(x-y)
  let tl = { x: 0, y: 0, v: Infinity };
  let br = { x: 0, y: 0, v: -Infinity };
  let tr = { x: 0, y: 0, v: -Infinity };
  let bl = { x: 0, y: 0, v: Infinity };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== bestLabel) continue;
      const s = x + y;
      const d = x - y;
      if (s < tl.v) tl = { x, y, v: s };
      if (s > br.v) br = { x, y, v: s };
      if (d > tr.v) tr = { x, y, v: d };
      if (d < bl.v) bl = { x, y, v: d };
    }
  }
  const q: Quad = [
    { x: tl.x, y: tl.y },
    { x: tr.x + 1, y: tr.y },
    { x: br.x + 1, y: br.y + 1 },
    { x: bl.x, y: bl.y + 1 },
  ];
  if (!isConvex(q)) return null;
  const area = polygonArea(q);
  if (area < total * 0.1) return null;
  // The component should mostly fill its quad (rejects odd blobs).
  if (bestSize / area < 0.75) return null;
  return q;
}

/** Pull each corner toward the centre by a fraction (trims dark edge pixels). */
export function insetQuad(q: Quad, f: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({ x: p.x + (cx - p.x) * f, y: p.y + (cy - p.y) * f })) as Quad;
}

export function scaleQuad(q: Quad, sx: number, sy = sx): Quad {
  return q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
}

/** Solve A x = b (n x n) with Gaussian elimination & partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('Singular matrix');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Homography H (row-major 3x3, h33 = 1) mapping each src[i] onto dst[i].
 */
export function homography(src: Point[], dst: Point[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(A, b), 1];
}

export function applyH(H: number[], p: Point): Point {
  const d = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / d, y: (H[3] * p.x + H[4] * p.y + H[5]) / d };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Natural output size for a flattened quad, capped to maxSide. */
export function outputSize(q: Quad, maxSide = 2480): { width: number; height: number } {
  let width = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let height = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, maxSide / Math.max(width, height));
  width = Math.max(1, Math.round(width * s));
  height = Math.max(1, Math.round(height * s));
  return { width, height };
}

/** Perspective-correct the quad region of src into a width x height image. */
export function warpPerspective(src: Img, q: Quad, width: number, height: number): Img {
  const out = createImg(width, height);
  // Map destination rect -> source quad (inverse mapping).
  const H = homography(fullQuad(width, height), q);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;
  const od = out.data;
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const den = H[6] * px + H[7] * py + H[8];
      let fx = (H[0] * px + H[1] * py + H[2]) / den - 0.5;
      let fy = (H[3] * px + H[4] * py + H[5]) / den - 0.5;
      fx = Math.min(Math.max(fx, 0), sw - 1);
      fy = Math.min(Math.max(fy, 0), sh - 1);
      const x0 = fx | 0;
      const y0 = fy | 0;
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * ax;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * ax;
        od[o + c] = top + (bot - top) * ay;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

/** Estimate the paper background: blurred local maximum of luminance. */
function backgroundLuma(gray: Uint8ClampedArray, w: number, h: number): Float32Array {
  // Down-sample with max-pooling so dark text doesn't pull the estimate down.
  const cell = Math.max(4, Math.round(Math.min(w, h) / 60));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const small = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let m = 0;
      const yEnd = Math.min(h, (cy + 1) * cell);
      const xEnd = Math.min(w, (cx + 1) * cell);
      for (let y = cy * cell; y < yEnd; y++) {
        for (let x = cx * cell; x < xEnd; x++) {
          const v = gray[y * w + x];
          if (v > m) m = v;
        }
      }
      small[cy * cw + cx] = m;
    }
  }
  // 3x3 max filter over cells so text larger than one cell doesn't darken the estimate.
  const dil = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= cw) continue;
          const v = small[yy * cw + xx];
          if (v > m) m = v;
        }
      }
      dil[cy * cw + cx] = m;
    }
  }
  const sm = boxBlur(dil, cw, ch, 2);
  // Bilinear up-sample back to full size.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(Math.max(y / cell - 0.5, 0), ch - 1);
    const y0 = fy | 0;
    const y1 = Math.min(y0 + 1, ch - 1);
    const ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(Math.max(x / cell - 0.5, 0), cw - 1);
      const x0 = fx | 0;
      const x1 = Math.min(x0 + 1, cw - 1);
      const ax = fx - x0;
      const top = sm[y0 * cw + x0] + (sm[y0 * cw + x1] - sm[y0 * cw + x0]) * ax;
      const bot = sm[y1 * cw + x0] + (sm[y1 * cw + x1] - sm[y1 * cw + x0]) * ax;
      out[y * w + x] = Math.max(1, top + (bot - top) * ay);
    }
  }
  return out;
}

/** Apply a named scan filter, returning a new image. */
export function applyFilter(src: Img, filter: FilterName): Img {
  const { width: w, height: h } = src;
  const out = createImg(w, h);
  const s = src.data;
  const o = out.data;
  if (filter === 'original') {
    o.set(s);
    return out;
  }
  const gray = toGray(src);
  if (filter === 'gray') {
    // Grayscale with illumination flattening and gentle contrast boost.
    const bg = backgroundLuma(gray, w, h);
    for (let i = 0; i < gray.length; i++) {
      const v = (gray[i] / bg[i]) * 255;
      const c = (v - 30) * (255 / 215);
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = c;
      o[i * 4 + 3] = 255;
    }
    return out;
  }
  if (filter === 'enhance') {
    // Colour "magic" filter: remove shadows/uneven lighting, whiten paper.
    const bg = backgroundLuma(gray, w, h);
    for (let i = 0; i < gray.length; i++) {
      const k = 255 / bg[i];
      for (let c = 0; c < 3; c++) {
        const v = s[i * 4 + c] * k;
        o[i * 4 + c] = (v - 25) * (255 / 220);
      }
      o[i * 4 + 3] = 255;
    }
    return out;
  }
  // 'bw': flatten illumination, then Bradley adaptive threshold.
  const bg = backgroundLuma(gray, w, h);
  const flat = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) flat[i] = Math.min(255, (gray[i] / bg[i]) * 255);
  const r = Math.max(4, Math.round(Math.max(w, h) / 32));
  const mean = boxBlur(flat, w, h, r);
  for (let i = 0; i < flat.length; i++) {
    // Local contrast catches faint strokes; the absolute bound catches large solid areas.
    const dark = (flat[i] < mean[i] * 0.88 && flat[i] < 215) || flat[i] < 140;
    const v = dark ? 0 : 255;
    o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v;
    o[i * 4 + 3] = 255;
  }
  return out;
}

/** Rotate by a multiple of 90° clockwise. */
export function rotate(src: Img, quarterTurns: number): Img {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (t === 0) return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
  const { width: w, height: h, data: s } = src;
  const ow = t % 2 ? h : w;
  const oh = t % 2 ? w : h;
  const out = createImg(ow, oh);
  const o = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (t === 1) { nx = h - 1 - y; ny = x; }
      else if (t === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      const si = (y * w + x) * 4;
      const di = (ny * ow + nx) * 4;
      o[di] = s[si]; o[di + 1] = s[si + 1]; o[di + 2] = s[si + 2]; o[di + 3] = s[si + 3];
    }
  }
  return out;
}
