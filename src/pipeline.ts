import { detectDocument, fullQuad, insetQuad, scaleQuad, type FilterName, type Quad } from './imaging';
import { blobToImg, imgToBlob } from './raster';
import { process } from './processor';
import { recognize } from './ocr';
import { getDoc, getPage, getSettings, refreshDocCache, savePage, uid } from './db';
import type { Page } from './types';

/** Max side for stored originals: plenty for OCR, keeps storage in check. */
const MAX_ORIGINAL = 3200;
const DETECT_SIZE = 320;

export const events = new EventTarget();
export const emit = (type: string, detail?: unknown) => events.dispatchEvent(new CustomEvent(type, { detail }));

export interface Prepared {
  original: Blob;
  width: number;
  height: number;
  quad: Quad;
  detected: boolean;
}

/** Normalise an input image (orientation, size) and auto-detect the page. */
export async function prepare(input: Blob): Promise<Prepared> {
  const img = await blobToImg(input, MAX_ORIGINAL);
  const original = await imgToBlob(img, 0.92);
  const small = await blobToImg(original, DETECT_SIZE);
  const q = detectDocument(small);
  const s = img.width / small.width;
  return {
    original,
    width: img.width,
    height: img.height,
    quad: q ? insetQuad(scaleQuad(q, s), 0.012) : fullQuad(img.width, img.height),
    detected: !!q,
  };
}

export async function buildPage(
  p: Prepared,
  quad: Quad = p.quad,
  filter?: FilterName,
  rotation = 0,
): Promise<Page> {
  const settings = await getSettings();
  const f = filter ?? settings.defaultFilter;
  const r = await process({ original: p.original, quad, filter: f, rotation, quality: settings.jpegQuality });
  return {
    id: uid(),
    original: p.original,
    originalWidth: p.width,
    originalHeight: p.height,
    quad,
    filter: f,
    rotation,
    ...r,
  };
}

/** Re-render a page after crop/filter/rotation edits (drops stale OCR). */
export async function reprocess(page: Page, changes: Partial<Pick<Page, 'quad' | 'filter' | 'rotation'>>): Promise<Page> {
  const settings = await getSettings();
  const next = { ...page, ...changes };
  const r = await process({
    original: next.original,
    quad: next.quad,
    filter: next.filter,
    rotation: next.rotation,
    quality: settings.jpegQuality,
  });
  const updated: Page = { ...next, ...r };
  // Rotating/cropping invalidates word positions; filter changes keep text but positions stay valid.
  if (changes.quad || changes.rotation !== undefined) delete updated.ocr;
  await savePage(updated);
  return updated;
}

// ---------- OCR queue ----------
const ocrActive = new Map<string, number>();
export const ocrProgress = (pageId: string) => ocrActive.get(pageId);

export async function runOcr(pageId: string, docId?: string): Promise<Page | undefined> {
  const page = await getPage(pageId);
  if (!page) return;
  const settings = await getSettings();
  ocrActive.set(pageId, 0);
  emit('ocr', { pageId, progress: 0 });
  try {
    const result = await recognize(page.processed, settings.ocrLangs, (status, p) => {
      if (status === 'recognizing text') {
        ocrActive.set(pageId, p);
        emit('ocr', { pageId, progress: p });
      }
    });
    const fresh = (await getPage(pageId)) ?? page;
    // Discard if the page changed shape while OCR was running.
    if (fresh.width !== result.width || fresh.height !== result.height) return fresh;
    fresh.ocr = result;
    await savePage(fresh);
    if (docId) {
      const doc = await getDoc(docId);
      if (doc) await refreshDocCache(doc);
    }
    return fresh;
  } finally {
    ocrActive.delete(pageId);
    emit('ocr', { pageId, progress: 1, done: true });
  }
}

export async function maybeAutoOcr(pageId: string, docId: string): Promise<void> {
  const s = await getSettings();
  if (s.autoOcr) runOcr(pageId, docId).catch((e) => emit('error', String(e?.message ?? e)));
}
