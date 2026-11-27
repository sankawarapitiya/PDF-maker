// End-to-end test: fake camera shows a photographed page; we scan it, wait for
// OCR, verify recognised text, and export a searchable PDF.
// Usage: npm run build && npm run test:e2e   (set NODE_PATH for a global Playwright)
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const out = join(process.cwd(), 'test-results');
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const PORT = 4179;

// 1. Render a synthetic "photo" of a document lying skewed on a dark desk.
async function makePhoto(browser) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await p.setContent(`<body style="margin:0;width:1280px;height:720px;background:radial-gradient(#4b3a2a,#20160e);overflow:hidden">
    <div style="position:absolute;left:390px;top:40px;width:500px;height:640px;background:#f4f1ea;
      transform:perspective(1400px) rotateX(8deg) rotateZ(-4deg);box-shadow:0 10px 40px #000;
      font:24px/1.5 Georgia,serif;color:#1b1b1b;padding:44px;box-sizing:border-box">
      <h1 style="font:bold 38px Arial;margin:0 0 18px">INVOICE 2048</h1>
      <p>Thank you for your purchase.</p>
      <p>The quick brown fox jumps over the lazy dog.</p>
      <p>Total amount due: 149 dollars</p>
      <p>Payment within thirty days.</p>
    </div></body>`);
  const jpg = await p.screenshot({ type: 'jpeg', quality: 92 });
  await p.close();
  writeFileSync(join(out, 'photo.jpg'), jpg);
  // A single-frame MJPEG works as Chromium's fake camera source.
  writeFileSync(join(out, 'camera.mjpeg'), jpg);
}

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => d.toString().includes(String(PORT)) && res());
  server.on('exit', () => rej(new Error('preview server exited')));
});

const fail = (m) => { throw new Error(m); };
let browser;
try {
  const pre = await chromium.launch();
  await makePhoto(pre);
  await pre.close();

  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${join(out, 'camera.mjpeg')}`,
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    permissions: ['camera'],
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (process.env.DEBUG) console.log('[console]', m.type(), m.text()); if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(350);
  await shot(page, '0-splash');
  await page.locator('#splash').waitFor({ state: 'detached', timeout: 5000 });
  await page.getByText('Your scans will appear here').waitFor();
  await shot(page, '1-library-empty');

  // Camera with live detection
  await page.getByLabel('Scan document').click();
  await page.locator('.cam-hint').waitFor({ state: 'hidden', timeout: 15000 });
  await page.waitForTimeout(500);
  await shot(page, '2-camera-detected');
  await page.getByLabel('Capture', { exact: true }).click();

  // Crop editor
  await page.getByText('Document detected').waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, '3-crop');
  await page.getByRole('button', { name: 'Done' }).click();

  // Document view, wait for background OCR
  await page.locator('.page-tile img').first().waitFor({ timeout: 20000 });
  await page.locator('.ocr-badge:text("Text")').waitFor({ timeout: 120000 });
  await shot(page, '4-document');

  // Page view: check OCR text
  await page.getByLabel('Page 1').click();
  const text = await page.locator('textarea.ocr-text').inputValue();
  console.log('OCR text:\n' + text);
  for (const w of ['INVOICE', 'quick brown fox', 'purchase']) {
    if (!text.toLowerCase().includes(w.toLowerCase())) fail(`OCR text missing "${w}"`);
  }
  await page.getByLabel('Show word boxes').click();
  await shot(page, '5-page-ocr');

  // Switch to B&W filter (re-processing in the worker)
  await page.getByRole('radio', { name: 'B & W' }).click();
  await page.locator('.busy-veil').waitFor({ state: 'hidden' });
  await page.waitForTimeout(300);
  await shot(page, '6-page-bw');

  // Import a second page from the gallery
  await page.getByLabel('Back').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Import', { exact: true }).click()]);
  await chooser.setFiles(join(out, 'photo.jpg'));
  await page.getByLabel('Page 2').waitFor({ timeout: 20000 });
  await page.locator('.ocr-badge:text("Text")').nth(1).waitFor({ timeout: 120000 });

  // Export PDF
  await page.getByText('Export', { exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByText('Save PDF').click()]);
  const pdfPath = join(out, 'scan.pdf');
  await dl.saveAs(pdfPath);
  if (!readFileSync(pdfPath).subarray(0, 5).toString().startsWith('%PDF')) fail('not a PDF');
  const pdfText = execFileSync('pdftotext', [pdfPath, '-']).toString();
  console.log('PDF text layer:\n' + pdfText);
  if (!/quick/i.test(pdfText)) fail('PDF has no searchable text layer');
  const pages = execFileSync('pdfinfo', [pdfPath]).toString().match(/Pages:\s+(\d+)/)?.[1];
  if (pages !== '2') fail(`expected 2 PDF pages, got ${pages}`);

  // WhatsApp: PDF (desktop browser without file sharing falls back to download)
  const [waDl] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByText('WhatsApp', { exact: true }).click();
      await page.locator('.sheet-backdrop.open').waitFor();
      await shot(page, '7a-whatsapp-sheet');
      await page.getByText('PDF document').click();
    })(),
  ]);
  if (!waDl.suggestedFilename().endsWith('.pdf')) fail('WhatsApp PDF fallback did not produce a PDF');
  // WhatsApp: recognised text opens a wa.me link
  let waRequest = '';
  await ctx.route(/wa\.me|whatsapp\.com/, (r) => {
    waRequest = r.request().url();
    return r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
  });
  await page.getByText('WhatsApp', { exact: true }).click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByText('Recognised text').click()]);
  await popup.waitForLoadState();
  const waUrl = decodeURIComponent(waRequest);
  console.log('WhatsApp URL:', waUrl.slice(0, 80));
  if (!/wa\.me|whatsapp\.com/.test(waUrl) || !/quick brown fox/i.test(waUrl)) fail('wa.me link missing text');
  await popup.close();

  // Library search finds the document by its OCR text
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator('#splash').waitFor({ state: 'detached', timeout: 5000 });
  await page.getByLabel('Search').fill('brown fox');
  await page.locator('.snippet').waitFor();
  await shot(page, '7-library-search');
  await page.getByLabel('Search').fill('');
  await shot(page, '7b-library');

  // Settings
  await page.getByLabel('Settings').click();
  await page.getByText('Text recognition (OCR)').waitFor();
  await page.waitForTimeout(300);
  await shot(page, '8-settings');

  // Language downloader (needs network access to cdn.jsdelivr.net; skip with SKIP_LANG=1)
  if (!process.env.SKIP_LANG) {
    await page.getByLabel('Find a language').fill('sinh');
    const row = page.locator('.lang-row[data-code="sin"]');
    await row.getByText('Get').click();
    await row.getByText(/Downloading/).waitFor({ timeout: 10000 }).catch(() => {});
    await shot(page, '9-lang-downloading');
    await row.getByText(/Downloaded ·/).waitFor({ timeout: 120000 });
    if (!(await row.getByRole('checkbox').isChecked())) fail('downloaded language not enabled');
    await page.getByLabel('Find a language').fill('');
    await page.getByRole('button', { name: 'Downloaded', exact: true }).click();
    await shot(page, '10-lang-downloaded');
    // Remove it again
    await row.getByLabel('Delete Sinhala').click();
    await page.locator('.modal .btn.danger').click();
    await page.locator('.lang-row[data-code="sin"]').waitFor({ state: 'detached' });
  }

  const realErrors = errors.filter((e) => !/favicon|Estimating resolution/i.test(e));
  if (realErrors.length) fail('Console errors:\n' + realErrors.join('\n'));
  console.log('\nE2E PASSED — screenshots in test-results/');
} finally {
  await browser?.close();
  server.kill();
}
