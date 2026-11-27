// E2E: folders, Word editor (.docx round trip, PDF) and printer settings / print sheet.
// Usage: npm run build && npm run test:e2e:docs   (NODE_PATH for a global Playwright)
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const out = join(process.cwd(), 'test-results');
mkdirSync(out, { recursive: true });
const shot = (p, n) => p.screenshot({ path: join(out, `docs-${n}.png`) });
const fail = (m) => { throw new Error(m); };
const PORT = 4183;
const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res) => preview.stdout.on('data', (d) => d.toString().includes(String(PORT)) && res()));

let browser;
try {
  browser = await chromium.launch();
  const photo = join(out, 'docs-photo.jpg');
  {
    const p = await browser.newPage({ viewport: { width: 900, height: 1100 } });
    await p.setContent(`<body style="margin:0;background:#2b2118;display:grid;place-items:center;height:1100px">
      <div style="width:700px;height:950px;background:#f7f5ef;padding:60px;box-sizing:border-box;font:30px/1.6 Georgia">
      <h1 style="font:bold 44px Arial">DELIVERY NOTE 512</h1><p>Six crates of oranges.</p><p>Signed by the warehouse manager.</p></div></body>`);
    writeFileSync(photo, await p.screenshot({ type: 'jpeg' }));
    await p.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator('#splash').waitFor({ state: 'detached' });

  // ── Folders ───────────────────────────────────────────────
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Invoices');
  await page.getByLabel('Colour #F5A524').click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.folder-card', { hasText: 'Invoices' }).waitFor();
  await page.locator('.folder-link', { hasText: 'Invoices' }).click();
  await page.locator('.breadcrumb', { hasText: 'Invoices' }).waitFor();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('2026');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.folder-card', { hasText: '2026' }).waitFor();
  // Import a scan into "Invoices"
  await page.getByLabel('Create new').click();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Import images').click()]);
  await fc.setFiles(photo);
  await page.locator('.ocr-badge:text("Text")').waitFor({ timeout: 120000 });
  await page.getByLabel('Back').click();
  await page.locator('.doc-item').first().waitFor();
  await shot(page, '1-folder');
  // Move it to Invoices/2026 with multi-select
  await page.getByRole('button', { name: 'Select' }).click();
  await page.locator('.doc-link').first().click();
  await page.getByRole('button', { name: 'Move' }).click();
  await page.locator('.tree-row', { hasText: '2026' }).click();
  await page.getByText('Moved to 2026').waitFor();
  await page.locator('.folder-link', { hasText: '2026' }).click();
  await page.locator('.doc-item').first().waitFor();
  const crumbs = await page.locator('.breadcrumb').innerText();
  if (!/Home\s*›\s*Invoices\s*›\s*2026/.test(crumbs)) fail('breadcrumb wrong: ' + crumbs);
  // Root search finds it with its folder path
  await page.goto(`http://localhost:${PORT}/`);
  await page.reload();
  await page.locator('#splash').waitFor({ state: 'detached' });
  await page.getByLabel('Search').fill('oranges');
  await page.locator('.doc-path', { hasText: 'Invoices › 2026' }).waitFor();
  await page.getByLabel('Search').fill('');
  await shot(page, '2-home-folders');

  // ── Word: from scan ────────────────────────────────────────
  await page.locator('.folder-link', { hasText: 'Invoices' }).click();
  await page.locator('.folder-link', { hasText: '2026' }).click();
  await page.locator('.doc-link').first().click();
  await page.getByText('More', { exact: true }).click();
  await page.getByText('Edit as Word document').click();
  await page.locator('.word-editor').waitFor();
  const fromScan = await page.locator('.word-editor').innerText();
  if (!/DELIVERY NOTE/i.test(fromScan) || !/oranges/i.test(fromScan)) fail('scan text missing in Word doc: ' + fromScan);

  // ── Word: new document, formatting, table ─────────────────
  await page.goto(`http://localhost:${PORT}/`);
  await page.reload();
  await page.locator('#splash').waitFor({ state: 'detached' });
  await page.getByLabel('Create new').click();
  await page.getByText('New Word document').click();
  const ed = page.locator('.word-editor');
  await ed.waitFor();
  await ed.click();
  await page.locator('select[aria-label="Paragraph style"]').selectOption('1');
  await page.keyboard.type('Quarterly Report');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Revenue grew ');
  await page.getByLabel('Bold').click();
  await page.keyboard.type('twelve percent');
  await page.getByLabel('Bold').click();
  await page.keyboard.type(' this quarter.');
  await page.keyboard.press('Enter');
  await page.getByLabel('Bulleted list').click();
  await page.keyboard.type('North region');
  await page.keyboard.press('Enter');
  await page.keyboard.type('South region');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.getByLabel('Insert table').click();
  await page.keyboard.type('Region');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Sales');
  await page.getByText('Saved', { exact: true }).waitFor();
  await shot(page, '3-word-editor');
  // Export .docx
  await page.getByLabel('Document options').click();
  const [docxDl] = await Promise.all([page.waitForEvent('download'), page.getByText('Save as Word (.docx)').click()]);
  const docxPath = join(out, 'report.docx');
  await docxDl.saveAs(docxPath);
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml']).toString();
  for (const [what, re] of [['heading', /Heading1/], ['text', /Quarterly Report/], ['bold run', /<w:b\/>[\s\S]*twelve percent/], ['bullets', /<w:numPr>/], ['table', /<w:tbl>/], ['cell', /Sales/]])
    if (!re.test(xml)) fail(`.docx missing ${what}`);
  console.log('docx ok:', xml.length, 'bytes of document.xml');
  // Export PDF
  await page.getByLabel('Document options').click();
  const [pdfDl] = await Promise.all([page.waitForEvent('download'), page.getByText('Export PDF').click()]);
  const pdfPath = join(out, 'report.pdf');
  await pdfDl.saveAs(pdfPath);
  const pdfText = execFileSync('pdftotext', [pdfPath, '-']).toString();
  if (!/Quarterly Report/.test(pdfText) || !/twelve percent/.test(pdfText)) fail('Word PDF text missing: ' + pdfText.slice(0, 200));
  // Re-import the .docx
  await page.getByLabel('Back').click();
  await page.getByLabel('Create new').click();
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Open Word file').click()]);
  await fc2.setFiles(docxPath);
  await page.locator('.word-editor h1', { hasText: 'Quarterly Report' }).waitFor();
  if (!(await page.locator('.word-editor strong', { hasText: 'twelve percent' }).count())) fail('bold lost on import');
  if (!(await page.locator('.word-editor table').count())) fail('table lost on import');
  if ((await page.locator('.word-editor li').count()) < 2) fail('list lost on import');
  await shot(page, '4-word-imported');

  // ── Printers ───────────────────────────────────────────────
  await page.goto(`http://localhost:${PORT}/#/settings/printers`);
  await page.reload();
  await page.locator('#splash').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Add printer' }).click();
  await page.locator('.editor-screen').waitFor();
  await page.locator('.editor-screen .chip', { hasText: 'Canon' }).click();
  if ((await page.getByLabel('Queue path').inputValue()) !== '/ipp/print') fail('Canon preset path');
  await page.locator('.editor-screen .chip', { hasText: 'Toshiba' }).click();
  if ((await page.getByLabel('Queue path').inputValue()) !== '/Print') fail('Toshiba preset path');
  await page.getByLabel('Printer name').fill('Floor 2 e-STUDIO');
  await page.getByLabel('IP address or host name').fill('ipp://192.168.1.50:631/Print');
  await page.getByLabel('Connection').selectOption('ipps');
  if ((await page.getByLabel('Port', { exact: true }).inputValue()) !== '443') fail('IPPS port preset');
  await page.getByLabel('Department ID').fill('4711');
  await page.getByLabel('More copies').click();
  await shot(page, '5-printer-editor');
  await page.locator('.editor-screen .topbar .btn', { hasText: 'Save' }).click();
  await page.locator('.printer-row', { hasText: 'Floor 2 e-STUDIO' }).waitFor();
  const row = await page.locator('.printer-row').innerText();
  if (!/192\.168\.1\.50:443/.test(row) || !/Default/.test(row)) fail('printer row: ' + row);
  await shot(page, '6-printers');
  // Print sheet from a scan
  await page.goto(`http://localhost:${PORT}/`);
  await page.reload();
  await page.locator('#splash').waitFor({ state: 'detached' });
  await page.getByLabel('Search').fill('oranges');
  await page.locator('.doc-item .icon-btn').first().click();
  await page.getByText('Print', { exact: true }).click();
  await page.locator('.print-sheet').waitFor();
  await page.locator('.printer-choice', { hasText: 'Floor 2 e-STUDIO' }).waitFor();
  await shot(page, '7-print-sheet');
  await page.evaluate(() => { window.__printed = 0; const orig = HTMLIFrameElement.prototype; void orig; });
  await page.locator('.print-go').click();
  await page.locator('iframe.print-frame').waitFor({ state: 'attached', timeout: 10000 });
  const src = await page.locator('iframe.print-frame').getAttribute('src');
  if (!src?.startsWith('blob:')) fail('system print did not get a PDF');

  // ── Delete folder, keep contents ───────────────────────────
  await page.goto(`http://localhost:${PORT}/`);
  await page.reload();
  await page.locator('#splash').waitFor({ state: 'detached' });
  await page.getByLabel('Options for folder Invoices').click();
  await page.getByText('Delete folder', { exact: true }).click();
  await page.getByText('Delete folder, keep contents').click();
  await page.locator('.folder-card', { hasText: '2026' }).waitFor();
  if (await page.locator('.folder-card', { hasText: 'Invoices' }).count()) fail('folder not deleted');

  if (errors.length) fail('page errors:\n' + errors.join('\n'));
  console.log('\nDOCS E2E PASSED — screenshots in test-results/docs-*.png');
} finally {
  await browser?.close();
  preview.kill();
}
