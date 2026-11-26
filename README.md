# DocScan OCR

A mobile document scanner with offline text recognition (OCR) and searchable-PDF export.
It runs as an installable **PWA** in any modern mobile browser, and as a **native Android/iOS app** through Capacitor.

## Features

- **Live camera scanning**: the page outline is detected in real time; optional auto-capture fires when the page is held steady; flash toggle where the device supports it.
- **Perspective correction**: auto-detected corners, draggable corner and edge handles with a magnifier loupe, plus "Auto" and "Full page" presets.
- **Scan filters**: Original, Magic color (removes shadows and whitens paper), Grayscale, and adaptive Black & White.
- **Multi-page documents**: add pages by camera or gallery import, reorder, rotate, re-crop, and delete.
- **Offline OCR**: Tesseract (WASM), with English built in.
- **Language downloader** (Settings → Text recognition): download, cancel, or delete packs for 40+ languages, including Sinhala, Tamil, Hindi, Arabic, Chinese, and Japanese. You can see progress and size for each pack. Downloaded packs are stored on the device, work offline, and can be combined (for example, English + Sinhala).
- **Share to WhatsApp**: send the PDF, page images, or recognised text. The Android app opens WhatsApp (or WhatsApp Business) directly with the files attached. On iOS and in mobile browsers, the system share sheet opens and you pick WhatsApp. Text-only messages go through a wa.me link.
- **Searchable PDF export**: an invisible text layer sits under each page image, so the PDF can be searched and its text selected. Page size can be Fit, A4, or Letter.
- **Text tools**: per-page and whole-document text, word-box overlay with confidence highlighting, copy, and share as .txt.
- **Library search** across document names *and* recognised text.
- **Private by design**: everything is stored on the device in IndexedDB, and nothing is uploaded.
- **Offline-first**: a service worker precaches the app, the OCR engine, and the English model.

## Getting started

```bash
npm install        # also copies the OCR engine + English model into public/tesseract
npm run dev        # http://localhost:5173 (use --host URL on your phone; camera needs HTTPS or localhost)
npm run build      # production build in dist/
npm run preview
```

To try it on a phone, serve `dist/` over HTTPS (any static host works, such as GitHub Pages, Netlify, or Vercel), open it, and use **Add to Home screen** or **Install app**.

### Android APK

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug        # → android/app/build/outputs/apk/debug/app-debug.apk
```

You need JDK 21 and the Android SDK (platform 36). Set `ANDROID_HOME`, or set `sdk.dir` in `android/local.properties`.

For a **signed release APK**:
1. Create `android/keystore.properties` (it's gitignored) with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`.
2. Run `./gradlew assembleRelease`.

The GitHub Actions workflow (`.github/workflows/android.yml`) builds the debug APK on every push and uploads it as an artifact. It also builds a signed release APK when the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` secrets are set.

### Native apps (Capacitor)

```bash
npm run android    # build, sync, and open in Android Studio
npm run ios        # build, sync, and open in Xcode (macOS)
```

Camera permission is already declared in `AndroidManifest.xml` and `Info.plist`. On native builds, PDFs are saved to the app's Documents folder or shared through the system share sheet.

## Tests

```bash
npm test                                   # unit tests (detection, homography, warp, filters, rotation)
npm run build && npm run test:e2e          # full browser flow with a fake camera (needs Playwright + poppler-utils)
```

The e2e test feeds a synthetic photo of a skewed invoice to Chromium's fake camera. It then:
1. detects the page and captures it,
2. checks the OCR result,
3. switches filters,
4. imports a second page,
5. exports a 2-page PDF and checks its text layer with `pdftotext`,
6. searches the library by recognised text.

Screenshots are written to `test-results/`.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/imaging.ts` | Pure image processing: document detection, homography/perspective warp, filters, rotation |
| `src/process*.ts` | Crop → filter → rotate → JPEG pipeline, run in a Web Worker |
| `src/ocr.ts` | Tesseract worker management, word boxes |
| `src/langs.ts`, `src/views/languages.ts` | Language pack downloader and storage, plus its Settings UI |
| `src/whatsapp.ts`, `android/…/WhatsAppSharePlugin.java` | WhatsApp sharing (a native Android plugin that targets WhatsApp directly) |
| `src/pdf.ts` | Searchable PDF builder (jsPDF + invisible text layer) |
| `src/db.ts` | IndexedDB storage for documents, pages and settings |
| `src/pipeline.ts` | Capture preparation, page building, background OCR queue |
| `src/views/` | Screens: library, camera, crop editor, document, page, text, settings |
| `android/`, `ios/` | Capacitor native projects |
