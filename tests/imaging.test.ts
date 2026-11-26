import { describe, expect, it } from 'vitest';
import {
  applyFilter, applyH, createImg, detectDocument, fullQuad, homography, isConvex,
  orderQuad, otsu, outputSize, rotate, warpPerspective, type Img, type Point, type Quad,
} from '../src/imaging';

function inside(p: Point, q: Quad): boolean {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c !== 0) {
      if (s === 0) s = Math.sign(c);
      else if (Math.sign(c) !== s) return false;
    }
  }
  return true;
}

/** Dark background with a bright (optionally rotated/skewed) sheet. */
function synth(w: number, h: number, sheet: Quad, bg = 40, fg = 235): Img {
  const img = createImg(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = inside({ x: x + 0.5, y: y + 0.5 }, sheet) ? fg : bg;
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  return img;
}

const near = (a: Point, b: Point, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

describe('homography', () => {
  it('maps the four source corners onto the destination corners', () => {
    const src: Quad = [{ x: 10, y: 20 }, { x: 200, y: 5 }, { x: 220, y: 300 }, { x: 0, y: 280 }];
    const dst = fullQuad(100, 140);
    const H = homography(src, dst);
    src.forEach((p, i) => {
      const m = applyH(H, p);
      expect(m.x).toBeCloseTo(dst[i].x, 6);
      expect(m.y).toBeCloseTo(dst[i].y, 6);
    });
  });
});

describe('quad helpers', () => {
  it('orders shuffled points TL, TR, BR, BL', () => {
    const q = orderQuad([{ x: 90, y: 95 }, { x: 5, y: 3 }, { x: 2, y: 98 }, { x: 100, y: 0 }]);
    expect(q).toEqual([{ x: 5, y: 3 }, { x: 100, y: 0 }, { x: 90, y: 95 }, { x: 2, y: 98 }]);
  });
  it('detects convexity', () => {
    expect(isConvex(fullQuad(10, 10))).toBe(true);
    expect(isConvex([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }])).toBe(false);
  });
  it('computes output size and caps it', () => {
    expect(outputSize(fullQuad(300, 400))).toEqual({ width: 300, height: 400 });
    expect(outputSize(fullQuad(5000, 2500), 2000)).toEqual({ width: 2000, height: 1000 });
  });
});

describe('otsu', () => {
  it('splits a bimodal histogram between the modes', () => {
    const g = new Uint8Array(1000).map((_, i) => (i < 500 ? 30 : 220));
    const t = otsu(g);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });
});

describe('detectDocument', () => {
  it('finds an axis-aligned sheet', () => {
    const sheet: Quad = [{ x: 40, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 260 }, { x: 40, y: 260 }];
    const q = detectDocument(synth(240, 300, sheet))!;
    expect(q).not.toBeNull();
    q.forEach((p, i) => expect(near(p, sheet[i], 4)).toBe(true));
  });

  it('finds a rotated, perspective-distorted sheet', () => {
    const sheet: Quad = [{ x: 70, y: 20 }, { x: 230, y: 50 }, { x: 200, y: 290 }, { x: 30, y: 250 }];
    const q = detectDocument(synth(260, 320, sheet))!;
    expect(q).not.toBeNull();
    q.forEach((p, i) => expect(near(p, sheet[i], 5)).toBe(true));
  });

  it('returns null for a uniform image', () => {
    const img = synth(100, 100, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
    expect(detectDocument(img)).toBeNull();
  });

  it('returns null when the bright area is tiny', () => {
    const sheet: Quad = [{ x: 10, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 25 }, { x: 10, y: 25 }];
    expect(detectDocument(synth(200, 200, sheet))).toBeNull();
  });
});

describe('warpPerspective', () => {
  it('flattens the sheet so the output is entirely the sheet colour', () => {
    const sheet: Quad = [{ x: 70, y: 20 }, { x: 230, y: 50 }, { x: 200, y: 290 }, { x: 30, y: 250 }];
    const src = synth(260, 320, sheet, 0, 250);
    // shrink the quad a little so we don't sample the anti-aliased edge
    const H = homography(fullQuad(1, 1), sheet);
    const inset = [
      applyH(H, { x: 0.03, y: 0.03 }), applyH(H, { x: 0.97, y: 0.03 }),
      applyH(H, { x: 0.97, y: 0.97 }), applyH(H, { x: 0.03, y: 0.97 }),
    ] as Quad;
    const out = warpPerspective(src, inset, 80, 100);
    expect(out.width).toBe(80);
    expect(out.height).toBe(100);
    let min = 255;
    for (let i = 0; i < out.data.length; i += 4) min = Math.min(min, out.data[i]);
    expect(min).toBeGreaterThan(240);
  });
});

describe('filters', () => {
  // Page with uneven lighting (gradient) and a dark "text" bar.
  const w = 120;
  const h = 80;
  const page = createImg(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const light = 150 + (x / w) * 90; // shadow on the left
      const isText = y > 35 && y < 45 && x > 20 && x < 100;
      const v = isText ? light * 0.25 : light;
      const i = (y * w + x) * 4;
      page.data[i] = v; page.data[i + 1] = v * 0.98; page.data[i + 2] = v * 0.95; page.data[i + 3] = 255;
    }
  const px = (img: Img, x: number, y: number) => img.data[(y * img.width + x) * 4];

  it('bw makes text black and paper white despite the shadow', () => {
    const bw = applyFilter(page, 'bw');
    expect(px(bw, 5, 5)).toBe(255);
    expect(px(bw, 115, 75)).toBe(255);
    expect(px(bw, 30, 40)).toBe(0);
    expect(px(bw, 90, 40)).toBe(0);
  });

  it('enhance whitens shadowed paper', () => {
    const e = applyFilter(page, 'enhance');
    expect(px(e, 5, 5)).toBeGreaterThan(230);
    expect(px(e, 30, 40)).toBeLessThan(80);
  });

  it('gray produces neutral pixels', () => {
    const g = applyFilter(page, 'gray');
    const i = (10 * w + 10) * 4;
    expect(g.data[i]).toBe(g.data[i + 1]);
    expect(g.data[i + 1]).toBe(g.data[i + 2]);
  });

  it('original is an exact copy', () => {
    expect(applyFilter(page, 'original').data).toEqual(page.data);
  });
});

describe('rotate', () => {
  const img = createImg(3, 2);
  // mark pixel (0,0) red
  img.data[0] = 255;
  it('rotates 90° clockwise', () => {
    const r = rotate(img, 1);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(r.data[(0 * 2 + 1) * 4]).toBe(255); // top-right
  });
  it('rotates 180°', () => {
    const r = rotate(img, 2);
    expect(r.data[(1 * 3 + 2) * 4]).toBe(255); // bottom-right
  });
  it('rotates 270°', () => {
    const r = rotate(img, 3);
    expect(r.data[(2 * 2 + 0) * 4]).toBe(255); // bottom-left
  });
});
