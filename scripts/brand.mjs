// Generates all brand artwork (logo, app icons, splash screens) from code.
//   public/icons/*      → PWA icons + favicon
//   assets/*.png        → masters for `npx capacitor-assets generate` (Android/iOS)
// Run: npm run brand   (uses Playwright to rasterise; set NODE_PATH for a global install)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const root = fileURLToPath(new URL('..', import.meta.url));

// ── Palette: "Deep Teal & Amber" ─────────────────────────────────────────────
export const C = {
  teal950: '#022C2A', teal900: '#063F3B', teal800: '#0A5C55', teal700: '#0F766E',
  teal600: '#0D9488', teal500: '#14B8A6', teal300: '#5EEAD4', teal100: '#CCFBF1',
  amber: '#F5A524', amberLight: '#FCD34D', ink: '#0B1416', paper: '#F5F7F6',
};

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.teal500}"/>
      <stop offset=".48" stop-color="${C.teal700}"/>
      <stop offset="1" stop-color="${C.teal900}"/>
    </linearGradient>
    <radialGradient id="shine" cx=".22" cy=".12" r=".8">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="scanned" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.amber}" stop-opacity="0"/>
      <stop offset="1" stop-color="${C.amber}" stop-opacity=".28"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-300%" width="140%" height="700%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="${C.teal950}" flood-opacity=".45"/>
    </filter>
    <clipPath id="sheet"><path d="M352 236h244l116 116v368a44 44 0 0 1-44 44H352a44 44 0 0 1-44-44V280a44 44 0 0 1 44-44Z"/></clipPath>
  </defs>`;

/** The glyph: a page with text lines, an amber scan beam and viewfinder corners (1024 space). */
const glyph = `
  <g filter="url(#drop)">
    <path d="M352 236h244l116 116v368a44 44 0 0 1-44 44H352a44 44 0 0 1-44-44V280a44 44 0 0 1 44-44Z" fill="#fff"/>
  </g>
  <path d="M596 236v72a44 44 0 0 0 44 44h72Z" fill="${C.teal100}"/>
  <g clip-path="url(#sheet)">
    <rect x="300" y="470" width="420" height="132" fill="url(#scanned)"/>
  </g>
  <rect x="368" y="330" width="170" height="34" rx="17" fill="${C.teal800}"/>
  <rect x="368" y="414" width="284" height="24" rx="12" fill="${C.teal600}" opacity=".55"/>
  <rect x="368" y="468" width="284" height="24" rx="12" fill="${C.teal600}" opacity=".55"/>
  <rect x="368" y="522" width="200" height="24" rx="12" fill="${C.teal600}" opacity=".55"/>
  <rect x="368" y="650" width="230" height="24" rx="12" fill="${C.teal600}" opacity=".25"/>
  <rect x="236" y="594" width="552" height="18" rx="9" fill="${C.amber}" filter="url(#glow)" opacity=".95"/>
  <rect x="236" y="596" width="552" height="14" rx="7" fill="${C.amberLight}"/>
  <g fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" opacity=".92">
    <path d="M196 268v-58a40 40 0 0 1 40-40h58"/>
    <path d="M730 170h58a40 40 0 0 1 40 40v58"/>
    <path d="M828 756v58a40 40 0 0 1-40 40h-58"/>
    <path d="M294 854h-58a40 40 0 0 1-40-40v-58"/>
  </g>`;

const svg = (body, size = 1024) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">${defs}${body}</svg>`;

/** Rounded tile (favicon / PWA "any" icon / in-app logo). */
const tileSvg = svg(`<rect width="1024" height="1024" rx="232" fill="url(#bg)"/><rect width="1024" height="1024" rx="232" fill="url(#shine)"/>${glyph}`);
/** Full-bleed square (platforms apply their own mask). */
const squareSvg = svg(`<rect width="1024" height="1024" fill="url(#bg)"/><rect width="1024" height="1024" fill="url(#shine)"/>${glyph}`);
/** Adaptive-icon layers (capacitor-assets insets them to the visible 72dp area). */
const fgSvg = svg(`<g transform="translate(512 512) scale(.86) translate(-512 -512)">${glyph}</g>`);
const bgSvg = svg(`<rect width="1024" height="1024" fill="url(#bg)"/><rect width="1024" height="1024" fill="url(#shine)"/>`);
/** Monochrome glyph for Android 13 themed icons. */
const monoSvg = svg(`<g transform="translate(512 512) scale(.86) translate(-512 -512)">
  <mask id="cut"><rect width="1024" height="1024" fill="#fff"/>
    <g fill="#000"><rect x="368" y="330" width="170" height="34" rx="17"/><rect x="368" y="414" width="284" height="24" rx="12"/>
    <rect x="368" y="468" width="284" height="24" rx="12"/><rect x="368" y="522" width="200" height="24" rx="12"/>
    <rect x="300" y="588" width="424" height="30"/></g></mask>
  <path mask="url(#cut)" d="M352 236h244l116 116v368a44 44 0 0 1-44 44H352a44 44 0 0 1-44-44V280a44 44 0 0 1 44-44Z" fill="#000"/>
  <rect x="236" y="596" width="552" height="14" rx="7" fill="#000"/>
  <g fill="none" stroke="#000" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
    <path d="M196 268v-58a40 40 0 0 1 40-40h58"/><path d="M730 170h58a40 40 0 0 1 40 40v58"/>
    <path d="M828 756v58a40 40 0 0 1-40 40h-58"/><path d="M294 854h-58a40 40 0 0 1-40-40v-58"/>
  </g></g>`);

const interWoff = readFileSync(`${root}node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`).toString('base64');

function splashHtml(dark) {
  const bg = dark
    ? `radial-gradient(1200px 1200px at 50% 44%, ${C.teal900} 0%, ${C.ink} 70%)`
    : `radial-gradient(1400px 1400px at 50% 40%, ${C.teal600} 0%, ${C.teal700} 40%, ${C.teal900} 100%)`;
  return `<html><head><style>
    @font-face { font-family: Inter; src: url(data:font/woff2;base64,${interWoff}) format('woff2'); font-weight: 100 900; }
    html,body { margin:0; width:2732px; height:2732px; background:${bg}; overflow:hidden; }
    .c { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:70px; font-family:Inter; }
    .logo { width:560px; height:560px; filter: drop-shadow(0 40px 80px rgba(2,44,42,.55)); }
    .word { font-size:168px; font-weight:800; letter-spacing:-5px; color:#fff; line-height:1; }
    .word span { color:${C.teal300}; }
    .tag { font-size:56px; font-weight:500; color:rgba(255,255,255,.72); letter-spacing:2px; margin-top:-30px; }
    .tag b { color:${C.amber}; font-weight:700; }
  </style></head><body><div class="c">
    <div class="logo">${tileSvg.replace('width="1024" height="1024"', 'width="560" height="560"')}</div>
    <div class="word">Doc<span>Scan</span></div>
    <div class="tag">Scan <b>·</b> Recognise <b>·</b> Share</div>
  </div></body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();

async function render(markup, size, path, transparent = false) {
  await page.setViewportSize({ width: size, height: size });
  const html = markup.startsWith('<svg')
    ? `<html><body style="margin:0;background:transparent">${markup.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`
    : markup;
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}

mkdirSync(`${root}assets`, { recursive: true });
mkdirSync(`${root}public/icons`, { recursive: true });

// Vector logo used by the app and as favicon
writeFileSync(`${root}public/icons/icon.svg`, tileSvg.replace(' width="1024" height="1024"', ''));

// PWA icons
await render(tileSvg, 192, `${root}public/icons/icon-192.png`, true);
await render(tileSvg, 512, `${root}public/icons/icon-512.png`, true);
await render(squareSvg.replace('scale(1)', ''), 512, `${root}public/icons/maskable-512.png`);
await render(squareSvg, 180, `${root}public/icons/apple-touch-icon.png`);

// Capacitor masters (Android + iOS)
await render(squareSvg, 1024, `${root}assets/icon-only.png`);
await render(fgSvg, 1024, `${root}assets/icon-foreground.png`, true);
await render(bgSvg, 1024, `${root}assets/icon-background.png`);
await render(monoSvg, 1024, `${root}assets/icon-monochrome.png`, true);
await render(splashHtml(false), 2732, `${root}assets/splash.png`);
await render(splashHtml(true), 2732, `${root}assets/splash-dark.png`);

// ── Native platforms ────────────────────────────────────────────────────────
if (process.argv.includes('--native')) {
  execSync(
    "npx capacitor-assets generate --android --ios --iconBackgroundColor '#0F766E' --iconBackgroundColorDark '#0B1416' " +
      "--splashBackgroundColor '#0F766E' --splashBackgroundColorDark '#0B1416'",
    { cwd: root, stdio: 'inherit' },
  );
  const res = `${root}android/app/src/main/res`;
  // Android 13+ themed (monochrome) icon layer.
  for (const [d, px] of [['ldpi', 81], ['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]]) {
    await render(monoSvg, px, `${res}/mipmap-${d}/ic_launcher_monochrome.png`, true);
  }
  // Full-bleed gradient background + inset foreground/monochrome.
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />
    </foreground>
    <monochrome>
        <inset android:drawable="@mipmap/ic_launcher_monochrome" android:inset="16.7%" />
    </monochrome>
</adaptive-icon>
`;
  writeFileSync(`${res}/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
  writeFileSync(`${res}/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
  // Re-encode the legacy (pre-Android 12) splash bitmaps as WebP: the PNG
  // gradients are ~8 MB in total, WebP brings them to a fraction of that.
  const { readdirSync, existsSync } = await import('node:fs');
  for (const dir of readdirSync(res).filter((d) => d.startsWith('drawable'))) {
    const png = `${res}/${dir}/splash.png`;
    if (!existsSync(png)) continue;
    const b64 = readFileSync(png).toString('base64');
    const webp = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.9).split(',')[1];
    }, `data:image/png;base64,${b64}`);
    writeFileSync(`${res}/${dir}/splash.webp`, Buffer.from(webp, 'base64'));
    rmSync(png);
  }
  // Remove Capacitor's template placeholders if they reappear.
  for (const f of ['drawable-v24/ic_launcher_foreground.xml', 'drawable/ic_launcher_background.xml']) rmSync(`${res}/${f}`, { force: true });
}

await browser.close();
console.log('brand assets written');
