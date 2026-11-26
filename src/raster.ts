import type { Img } from './imaging';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: AnyCanvas) {
  return c.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
}

/** Decode a blob into an RGBA buffer, optionally downscaling to maxSide. */
export async function blobToImg(blob: Blob, maxSide = Infinity): Promise<Img> {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const id = g.getImageData(0, 0, w, h);
  return { data: id.data, width: w, height: h };
}

export function imgToCanvas(img: Img): AnyCanvas {
  const c = makeCanvas(img.width, img.height);
  ctx2d(c).putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}

export async function canvasToBlob(c: AnyCanvas, type = 'image/jpeg', quality = 0.85): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise((res, rej) =>
    (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality),
  );
}

export async function imgToBlob(img: Img, quality = 0.85): Promise<Blob> {
  return canvasToBlob(imgToCanvas(img), 'image/jpeg', quality);
}

export async function blobToDataURL(b: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(b);
    });
  }
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${b.type};base64,${btoa(bin)}`;
}

/** Small JPEG data URL thumbnail. */
export async function thumbnail(img: Img, maxSide = 320): Promise<string> {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const src = imgToCanvas(img);
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src as CanvasImageSource, 0, 0, w, h);
  return blobToDataURL(await canvasToBlob(c, 'image/jpeg', 0.7));
}
