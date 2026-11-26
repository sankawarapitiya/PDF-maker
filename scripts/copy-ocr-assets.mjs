// Copies Tesseract worker, WASM core and English language data into public/
// so OCR works fully offline (and inside native Capacitor builds).
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'tesseract');
mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

// tesseract.js v7 bug: `initialize` builds the language string from each
// { code, data } object's `data` (the raw bytes) instead of its `code`.
// We pass preloaded language packs as such objects, so patch the worker.
const BUGGY = 'return"string"==typeof t?t:t.data})).join("+")';
let worker = readFileSync(join(nm, 'tesseract.js/dist/worker.min.js'), 'utf8');
if (worker.includes(BUGGY)) worker = worker.replace(BUGGY, 'return"string"==typeof t?t:t.code})).join("+")');
else if (!worker.includes('t.code})).join("+")')) console.warn('copy-ocr-assets: tesseract worker patch not applied; check preloaded-language support');
writeFileSync(join(out, 'worker.min.js'), worker);
for (const f of [
  'tesseract-core-lstm.js', 'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.js', 'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js',
]) {
  const src = join(nm, 'tesseract.js-core', f);
  if (existsSync(src)) cpSync(src, join(out, 'core', f));
}
cpSync(join(nm, '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz'));
console.log('OCR assets copied to public/tesseract');
