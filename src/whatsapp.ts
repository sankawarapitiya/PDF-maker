import { Capacitor, registerPlugin } from '@capacitor/core';
import { writeTempFile } from './share';

interface WhatsAppSharePlugin {
  isAvailable(): Promise<{ whatsapp: boolean; business: boolean }>;
  share(opts: { files?: string[]; mimeType?: string; text?: string; phone?: string; business?: boolean }): Promise<{ app: string }>;
}

const Native = registerPlugin<WhatsAppSharePlugin>('WhatsAppShare');
const isAndroidApp = () => Capacitor.getPlatform() === 'android';

export interface WaFile {
  blob: Blob;
  name: string;
}

export type WaResult = 'sent' | 'sheet' | 'cancelled' | 'downloaded';

/**
 * Send files (and/or a caption) to WhatsApp.
 * - Android app: opens WhatsApp directly with the files attached.
 * - iOS app / mobile browsers: system share sheet with files (pick WhatsApp).
 * - Text only: opens a wa.me link.
 * - Elsewhere: falls back to downloading the files.
 */
export async function shareToWhatsApp(files: WaFile[], text?: string): Promise<WaResult> {
  if (isAndroidApp()) {
    const uris = await Promise.all(files.map((f) => writeTempFile(f.blob, f.name)));
    const types = new Set(files.map((f) => f.blob.type));
    await Native.share({
      files: uris,
      mimeType: types.size === 1 ? [...types][0] : '*/*',
      text,
    });
    return 'sent';
  }

  if (!files.length) {
    window.open(`https://wa.me/?text=${encodeURIComponent(text ?? '')}`, '_blank');
    return 'sent';
  }

  if (Capacitor.isNativePlatform()) {
    const { Share } = await import('@capacitor/share');
    const uris = await Promise.all(files.map((f) => writeTempFile(f.blob, f.name)));
    try {
      await Share.share({ files: uris, text, dialogTitle: 'Send to WhatsApp' });
    } catch {
      return 'cancelled';
    }
    return 'sheet';
  }

  const fileObjs = files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
  if (navigator.canShare?.({ files: fileObjs })) {
    try {
      await navigator.share({ files: fileObjs, text });
      return 'sheet';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const { download } = await import('./share');
  for (const f of files) await download(f.blob, f.name);
  return 'downloaded';
}

export async function whatsAppInstalled(): Promise<boolean | null> {
  if (!isAndroidApp()) return null;
  try {
    const r = await Native.isAvailable();
    return r.whatsapp || r.business;
  } catch {
    return null;
  }
}
