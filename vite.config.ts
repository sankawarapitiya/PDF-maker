import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        name: 'DocScan OCR',
        short_name: 'DocScan',
        description: 'Scan documents, recognise text offline and export searchable PDFs.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell and the offline OCR engine + English model.
        globPatterns: ['**/*.{js,css,html,svg,png,wasm,gz}'],
        // Precache the SIMD build used by virtually all current phones; the
        // fallback builds are cached on first use.
        globIgnores: ['tesseract/core/tesseract-core-lstm*', 'tesseract/core/tesseract-core-relaxedsimd*'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /\/tesseract\/core\//,
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-core' },
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\//,
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-lang-cdn', expiration: { maxEntries: 30 } },
          },
        ],
      },
    }),
  ],
});
