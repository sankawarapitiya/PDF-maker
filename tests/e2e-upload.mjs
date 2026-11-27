// E2E: server upload + security. Starts the reference server and the built app.
// Usage: npm run build && npm run test:e2e:upload  (NODE_PATH for a global Playwright)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import { createServer, loadConfig, hashPassword } from '../server/index.mjs';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const out = join(process.cwd(), 'test-results');
mkdirSync(out, { recursive: true });
const shot = (p, n) => p.screenshot({ path: join(out, `upload-${n}.png`) });
const fail = (m) => { throw new Error(m); };
const APP = 4182, API = 4190;
const SECRET = 'e2e-signing-secret-1234567890';
const PIN = '2580';

const dataDir = mkdtempSync(join(os.tmpdir(), 'docscan-e2e-'));
writeFileSync(join(dataDir, 'users.json'), JSON.stringify({ alice: { password: hashPassword('correct horse battery'), name: 'Alice' } }));
const cfg = loadConfig({ dataDir, signingSecret: SECRET, log: false, allowedOrigins: `http://localhost:${APP}`, name: 'Acme Records' });
let api = createServer(cfg);
const startApi = () => new Promise((r) => api.listen(API, '127.0.0.1', r));
await startApi();

const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(APP), '--strictPort'], { stdio: 'pipe' });
await new Promise((res) => preview.stdout.on('data', (d) => d.toString().includes(String(APP)) && res()));

let browser;
try {
  browser = await chromium.launch();
  // Document photo
  const photo = join(out, 'upload-photo.jpg');
  {
    const p = await browser.newPage({ viewport: { width: 900, height: 1100 } });
    await p.setContent(`<body style="margin:0;background:#2b2118;display:grid;place-items:center;height:1100px">
      <div style="width:700px;height:950px;background:#f7f5ef;padding:60px;box-sizing:border-box;font:30px/1.6 Georgia">
      <h1 style="font:bold 44px Arial">PURCHASE ORDER 77</h1><p>Deliver twelve boxes of paper.</p><p>Reference code alpha bravo.</p></div></body>`);
    writeFileSync(photo, await p.screenshot({ type: 'jpeg' }));
    await p.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const base = `http://localhost:${APP}/`;
  await page.goto(base);
  await page.locator('#splash').waitFor({ state: 'detached' });

  // Scan (import) a document and wait for OCR
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByLabel('Import images').click()]);
  await fc.setFiles(photo);
  await page.locator('.ocr-badge:text("Text")').waitFor({ timeout: 120000 });
  const docUrl = page.url();

  // Upload before setup → prompts to configure
  await page.getByText('Upload', { exact: true }).click();
  await page.getByText('Connect a server first').waitFor();
  await shot(page, '1-not-configured');
  await page.getByRole('button', { name: 'Open settings' }).click();

  // Configure server
  await page.locator('#server').waitFor();
  await page.locator('#server label.row.toggle input').first().check();
  const url = page.getByLabel('Server address');
  await url.fill(`http://evil.example.com/api`);
  await url.blur();
  await page.getByText('For security the server must use HTTPS').waitFor();
  await url.fill(`http://localhost:${API}/api`);
  await url.blur();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByText('Connected to Acme Records').waitFor();
  // Signing secret (Advanced)
  await page.locator('details.advanced summary').click();
  await page.getByLabel('Request signing secret', { exact: true }).fill(SECRET);
  await page.locator('details.advanced .btn.primary', { hasText: 'Save' }).click();
  await page.getByText(/Saved \(encrypted\)/).waitFor();
  // Sign in with password (server only offers password auth → auto-selected)
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('wrong password!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Wrong username or password').waitFor();
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Signed in as Alice').waitFor();
  await page.locator('#server').scrollIntoViewIfNeeded();
  await shot(page, '2-server-settings');

  // Credentials must not be readable in plain text from storage
  const leaked = await page.evaluate(async (secret) => {
    const dbs = await indexedDB.databases();
    const dump = [];
    for (const { name } of dbs) {
      const db = await new Promise((r) => { const q = indexedDB.open(name); q.onsuccess = () => r(q.result); });
      for (const store of db.objectStoreNames) {
        const all = await new Promise((r) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => r(q.result); });
        dump.push(JSON.stringify(all, (k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? '[bytes]' : v)));
      }
      db.close();
    }
    const s = dump.join('\n');
    return s.includes(secret) || s.includes('correct horse battery');
  }, SECRET);
  if (leaked) fail('secret or password found in plain text storage');

  // App lock
  await page.getByLabel('App lock').check();
  await page.locator('.lock-screen').waitFor();
  await page.keyboard.type('1111');
  await page.keyboard.press('Enter');
  await page.getByText('Avoid repeating the same digit').waitFor();
  await page.keyboard.type(PIN); await page.keyboard.press('Enter');
  await page.getByText('Confirm your PIN').waitFor();
  await shot(page, '3-create-pin');
  await page.keyboard.type(PIN); await page.keyboard.press('Enter');
  await page.locator('.lock-screen').waitFor({ state: 'detached' });

  // Upload with doc-ID
  await page.goto(docUrl);
  await page.reload();
  await page.locator('#splash').waitFor({ state: 'detached' });
  await page.locator('.lock-screen').waitFor();
  await page.keyboard.type('9999');
  await page.getByText(/Wrong PIN/).waitFor();
  await shot(page, '4-lock-screen');
  await page.keyboard.type(PIN);
  await page.locator('.lock-screen').waitFor({ state: 'detached' });
  await page.getByText('Upload', { exact: true }).click();
  const idInput = page.getByRole('textbox', { name: 'Doc-ID' });
  await idInput.fill('bad id!');
  await page.getByText('Doc-ID format is not valid for this server').waitFor();
  await idInput.fill('PO-77');
  await shot(page, '5-upload-sheet');
  await page.locator('.upload-send').click();
  await page.locator('.upload-pill.ok', { hasText: 'Uploaded · PO-77' }).waitFor({ timeout: 30000 });
  await shot(page, '6-uploaded');

  // Verify on the server
  const dir = join(dataDir, 'documents', 'PO-77');
  const pdfFile = readdirSync(dir).find((f) => f.endsWith('.pdf'));
  const meta = JSON.parse(readFileSync(join(dir, pdfFile.replace('.pdf', '.json')), 'utf8'));
  const sha = createHash('sha256').update(readFileSync(join(dir, pdfFile))).digest('hex');
  if (sha !== meta.sha256) fail('checksum mismatch on server');
  if (meta.user !== 'alice') fail('upload not attributed to signed-in user');
  const text = readFileSync(join(dir, pdfFile.replace('.pdf', '.txt')), 'utf8');
  if (!/PURCHASE ORDER/i.test(text)) fail('OCR text missing on server');
  console.log('Server received', pdfFile, meta.bytes, 'bytes, sha256 ok, text ok');

  // Offline queue: stop server, upload, restart, retry
  await new Promise((r) => api.close(r));
  await page.locator('.upload-pill').click();
  await page.getByText('Upload again').click();
  await page.getByRole('textbox', { name: 'Doc-ID' }).fill('PO-78');
  await page.locator('.upload-send').click();
  await page.locator('.upload-pill.warn', { hasText: 'PO-78' }).waitFor({ timeout: 20000 });
  await shot(page, '7-queued');
  api = createServer(cfg);
  await startApi();
  await page.locator('.upload-pill').click();
  await page.getByText('Retry now').click();
  await page.locator('.upload-pill.ok', { hasText: 'Uploaded · PO-78' }).waitFor({ timeout: 30000 });
  if (!existsSync(join(dataDir, 'documents', 'PO-78'))) fail('queued upload never arrived');

  // Server settings are PIN-gated
  await page.goto(`${base}#/settings/server`);
  await page.reload();
  await page.locator('#splash').waitFor({ state: 'detached' });
  await page.keyboard.type(PIN);
  await page.locator('.lock-screen').waitFor({ state: 'detached' });
  await page.getByText('Server settings are protected by your PIN.').waitFor();
  await shot(page, '8-gated');

  if (errors.length) fail('page errors:\n' + errors.join('\n'));
  console.log('\nUPLOAD E2E PASSED — screenshots in test-results/upload-*.png');
} finally {
  await browser?.close();
  preview.kill();
  api.close();
}
