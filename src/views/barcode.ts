import { h, icon } from '../ui';

interface Detector {
  detect(src: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = { new (o?: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };
const BD = () => (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;

/** True when the platform can read barcodes / QR codes from the camera. */
export async function barcodeSupported(): Promise<boolean> {
  try {
    return !!BD() && !!navigator.mediaDevices?.getUserMedia && (await BD()!.getSupportedFormats()).length > 0;
  } catch {
    return false;
  }
}

/** Full-screen camera that resolves with the first barcode / QR value seen. */
export function scanBarcode(): Promise<string | null> {
  return new Promise(async (resolve) => {
    const Ctor = BD();
    if (!Ctor) return resolve(null);
    const formats = await Ctor.getSupportedFormats();
    const detector = new Ctor({ formats });
    let stream: MediaStream | null = null;
    let timer = 0;
    const video = h('video', { class: 'cam-video', playsinline: true, muted: true, autoplay: true });
    const close = (v: string | null) => {
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      el.remove();
      resolve(v);
    };
    const el = h(
      'div',
      { class: 'barcode-screen' },
      video,
      h('div', { class: 'barcode-frame' }, h('i', { class: 'barcode-beam' })),
      h('header', { class: 'topbar dark floating' },
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => close(null) }, icon('close')),
        h('h2', null, 'Scan doc-ID')),
      h('p', { class: 'cam-hint' }, 'Point at the barcode or QR code'),
    );
    document.body.appendChild(el);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = stream;
      await video.play().catch(() => undefined);
    } catch {
      return close(null);
    }
    timer = window.setInterval(async () => {
      if (!video.videoWidth) return;
      try {
        const found = await detector.detect(video);
        const v = found.find((f) => f.rawValue?.trim())?.rawValue.trim();
        if (v) {
          navigator.vibrate?.(40);
          close(v);
        }
      } catch {
        /* keep trying */
      }
    }, 250);
  });
}
