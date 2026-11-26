import { createStore, del, get, keys, set } from 'idb-keyval';

/** OCR language packs: English ships with the app, others are downloaded on demand. */
export const LANGUAGES: Record<string, string> = {
  eng: 'English', sin: 'Sinhala', tam: 'Tamil', hin: 'Hindi', ben: 'Bengali', mar: 'Marathi',
  tel: 'Telugu', kan: 'Kannada', mal: 'Malayalam', guj: 'Gujarati', pan: 'Punjabi', urd: 'Urdu',
  nep: 'Nepali', spa: 'Spanish', fra: 'French', deu: 'German', ita: 'Italian', por: 'Portuguese',
  nld: 'Dutch', pol: 'Polish', ces: 'Czech', swe: 'Swedish', dan: 'Danish', nor: 'Norwegian',
  fin: 'Finnish', ron: 'Romanian', hun: 'Hungarian', ell: 'Greek', tur: 'Turkish', rus: 'Russian',
  ukr: 'Ukrainian', ara: 'Arabic', fas: 'Persian', heb: 'Hebrew', chi_sim: 'Chinese (Simplified)',
  chi_tra: 'Chinese (Traditional)', jpn: 'Japanese', kor: 'Korean', tha: 'Thai', vie: 'Vietnamese',
  ind: 'Indonesian', msa: 'Malay', fil: 'Filipino', swa: 'Swahili',
};

export const BUNDLED = 'eng';
const base = new URL(import.meta.env.BASE_URL, location.href).href;
export const LOCAL_TESS = new URL('tesseract/', base).href;
const remoteUrl = (code: string) =>
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`;

interface Stored {
  data: Uint8Array;
  size: number;
  at: number;
}

const store = createStore('docscan-langs', 'langs');
const active = new Map<string, AbortController>();

export const langEvents = new EventTarget();
export interface LangProgress {
  code: string;
  loaded: number;
  total: number;
  state: 'downloading' | 'done' | 'error' | 'cancelled' | 'deleted';
  error?: string;
}
const emit = (d: LangProgress) => langEvents.dispatchEvent(new CustomEvent('progress', { detail: d }));

/** Sizes (bytes) of downloaded packs; English is always present. */
export async function downloadedLangs(): Promise<Map<string, number>> {
  const out = new Map<string, number>([[BUNDLED, 0]]);
  for (const k of (await keys(store)) as string[]) {
    const s = await get<Stored>(k, store);
    if (s) out.set(k, s.size);
  }
  return out;
}

export async function isDownloaded(code: string): Promise<boolean> {
  return code === BUNDLED || (await get(code, store)) !== undefined;
}

export const isDownloading = (code: string) => active.has(code);

/** Download a language pack with streaming progress; resolves once stored. */
export async function downloadLang(code: string): Promise<void> {
  if (code === BUNDLED || active.has(code)) return;
  const ctrl = new AbortController();
  active.set(code, ctrl);
  let loaded = 0;
  let total = 0;
  try {
    emit({ code, loaded, total, state: 'downloading' });
    const res = await fetch(remoteUrl(code), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    total = Number(res.headers.get('content-length')) || 0;
    const chunks: Uint8Array[] = [];
    const reader = res.body?.getReader();
    if (reader) {
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (performance.now() - lastEmit > 100) {
          lastEmit = performance.now();
          emit({ code, loaded, total, state: 'downloading' });
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      loaded = buf.length;
    }
    const data = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.length;
    }
    // gzip magic number check guards against error pages being stored.
    if (data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('Invalid language data');
    await set(code, { data, size: loaded, at: Date.now() } satisfies Stored, store);
    emit({ code, loaded, total: loaded, state: 'done' });
  } catch (e) {
    const cancelled = (e as Error).name === 'AbortError';
    emit({ code, loaded, total, state: cancelled ? 'cancelled' : 'error', error: (e as Error).message });
    if (!cancelled) throw e;
  } finally {
    active.delete(code);
  }
}

export function cancelDownload(code: string): void {
  active.get(code)?.abort();
}

export async function deleteLang(code: string): Promise<void> {
  if (code === BUNDLED) return;
  await del(code, store);
  emit({ code, loaded: 0, total: 0, state: 'deleted' });
}

/** Gzipped traineddata for a language, downloading it first if needed. */
export async function langData(code: string): Promise<Uint8Array> {
  if (code === BUNDLED) {
    // Android's asset packager stores .gz assets decompressed and drops the
    // extension, so try both names (Tesseract accepts gzipped or raw data).
    for (const name of ['eng.traineddata.gz', 'eng.traineddata']) {
      try {
        const res = await fetch(`${LOCAL_TESS}lang/${name}`);
        if (!res.ok) continue;
        const data = new Uint8Array(await res.arrayBuffer());
        // Servers with an SPA fallback answer missing files with index.html.
        const isHtml = data[0] === 0x3c || /html/i.test(res.headers.get('content-type') ?? '');
        if (data.length > 1024 && !isHtml) return data;
      } catch {
        /* try the next name */
      }
    }
    throw new Error('Bundled English data missing');
  }
  let s = await get<Stored>(code, store);
  if (!s) {
    await downloadLang(code);
    s = await get<Stored>(code, store);
  }
  if (!s) throw new Error(`${LANGUAGES[code] ?? code} is not downloaded`);
  return s.data;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
