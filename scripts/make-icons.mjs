// Renders public/icons/icon.svg to the PNG sizes the manifest needs (uses Playwright).
import { createRequire } from 'node:module';
// Use a local or globally installed Playwright (set NODE_PATH for global).
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = (n) => new URL(`../public/icons/${n}`, import.meta.url).pathname;
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['maskable-512.png', 512, 0.12], ['apple-touch-icon.png', 180, 0]]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  const bg = pad ? '#2563eb' : 'transparent';
  await page.setContent(`<body style="margin:0;background:${bg};display:grid;place-items:center;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`);
  await page.screenshot({ path: out(name), omitBackground: !pad });
}
await browser.close();
console.log('icons written');
