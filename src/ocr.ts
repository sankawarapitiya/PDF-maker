import { createWorker, OEM, PSM, type Worker as TWorker } from 'tesseract.js';
import type { OcrResult, OcrWord } from './types';

export const LANGUAGES: Record<string, string> = {
  eng: 'English', sin: 'Sinhala', tam: 'Tamil', hin: 'Hindi', ben: 'Bengali',
  spa: 'Spanish', fra: 'French', deu: 'German', ita: 'Italian', por: 'Portuguese',
  nld: 'Dutch', pol: 'Polish', tur: 'Turkish', rus: 'Russian', ukr: 'Ukrainian',
  ara: 'Arabic', fas: 'Persian', heb: 'Hebrew', chi_sim: 'Chinese (Simplified)',
  chi_tra: 'Chinese (Traditional)', jpn: 'Japanese', kor: 'Korean', tha: 'Thai',
  vie: 'Vietnamese', ind: 'Indonesian', msa: 'Malay',
};

const base = new URL(import.meta.env.BASE_URL, location.href).href;
const LOCAL = new URL('tesseract/', base).href;
const CDN_LANG = (l: string) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l}/4.0.0_best_int`;

let worker: TWorker | null = null;
let workerLangs = '';
let progressCb: ((status: string, p: number) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function ensureWorker(langs: string[]): Promise<TWorker> {
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  // Bundled English works offline; other languages download once from the CDN
  // and are cached in IndexedDB by Tesseract.
  const langPath = langs[0] === 'eng' ? `${LOCAL}lang` : CDN_LANG(langs[0]);
  const w = await createWorker(langs, OEM.LSTM_ONLY, {
    workerPath: `${LOCAL}worker.min.js`,
    corePath: `${LOCAL}core`,
    langPath,
    logger: (m) => progressCb?.(m.status, m.progress),
  });
  await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
  worker = w;
  workerLangs = key;
  return w;
}

/** Fetch each language's data separately when multiple languages are selected. */
async function ensureMulti(langs: string[]): Promise<TWorker> {
  if (langs.length === 1) return ensureWorker(langs);
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (worker) await worker.terminate();
  worker = null;
  const data = await Promise.all(
    langs.map(async (l) => {
      const url = l === 'eng' ? `${LOCAL}lang/eng.traineddata.gz` : `${CDN_LANG(l)}/${l}.traineddata.gz`;
      const cache = await caches.open('ocr-langs');
      let res = await cache.match(url);
      if (!res) {
        progressCb?.(`downloading ${LANGUAGES[l] ?? l}`, 0);
        res = await fetch(url);
        if (!res.ok) throw new Error(`Could not download ${l} language data`);
        await cache.put(url, res.clone());
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { code: l, data: buf };
    }),
  );
  const w = await createWorker(data as never, OEM.LSTM_ONLY, {
    workerPath: `${LOCAL}worker.min.js`,
    corePath: `${LOCAL}core`,
    gzip: true,
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
      const w = await ensureMulti(langs.length ? langs : ['eng']);
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
