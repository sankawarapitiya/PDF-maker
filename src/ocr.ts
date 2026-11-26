import { createWorker, OEM, PSM, type Worker as TWorker } from 'tesseract.js';
import { LANGUAGES, LOCAL_TESS, langData } from './langs';
import type { OcrResult, OcrWord } from './types';

export { LANGUAGES };

let worker: TWorker | null = null;
let workerLangs = '';
let progressCb: ((status: string, p: number) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** (Re)create the Tesseract worker with the given language packs loaded. */
async function ensureWorker(langs: string[]): Promise<TWorker> {
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (worker) await worker.terminate();
  worker = null;
  const data = await Promise.all(
    langs.map(async (code) => {
      progressCb?.(`loading ${LANGUAGES[code] ?? code}`, 0);
      return { code, data: await langData(code) };
    }),
  );
  const w = await createWorker(data as never, OEM.LSTM_ONLY, {
    workerPath: `${LOCAL_TESS}worker.min.js`,
    corePath: `${LOCAL_TESS}core`,
    // Language data is managed by langs.ts; avoid a second copy in Tesseract's cache.
    cacheMethod: 'none',
    logger: (m) => progressCb?.(m.status, m.progress),
  });
  await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
  worker = w;
  workerLangs = key;
  return w;
}

export function recognize(
  image: Blob,
  langs: string[],
  onProgress?: (status: string, p: number) => void,
): Promise<OcrResult> {
  const job = queue.then(async () => {
    progressCb = onProgress ?? null;
    try {
      const w = await ensureWorker(langs.length ? langs : ['eng']);
      const bmp = await createImageBitmap(image);
      const width = bmp.width;
      const height = bmp.height;
      bmp.close?.();
      const { data } = await w.recognize(image, {}, { text: true, blocks: true });
      const words: OcrWord[] = [];
      for (const b of data.blocks ?? [])
        for (const p of b.paragraphs)
          for (const l of p.lines)
            for (const wd of l.words) {
              if (!wd.text.trim()) continue;
              words.push({
                text: wd.text,
                bbox: [wd.bbox.x0, wd.bbox.y0, wd.bbox.x1, wd.bbox.y1],
                conf: Math.round(wd.confidence),
              });
            }
      return {
        text: data.text.trim(),
        words,
        lang: langs.join('+'),
        width,
        height,
        confidence: Math.round(data.confidence),
        at: Date.now(),
      };
    } finally {
      progressCb = null;
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
