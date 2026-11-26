import { Capacitor } from '@capacitor/core';
import { blobToDataURL } from './raster';
import { toast } from './ui';

export const isNative = () => Capacitor.isNativePlatform();

export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'scan';
}

async function writeNative(blob: Blob, filename: string, dir: 'cache' | 'documents') {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const data = (await blobToDataURL(blob)).split(',')[1];
  const res = await Filesystem.writeFile({
    path: filename,
    data,
    directory: dir === 'cache' ? Directory.Cache : Directory.Documents,
    recursive: true,
  });
  return res.uri;
}

async function shareNative(blob: Blob, filename: string, title: string) {
  const { Share } = await import('@capacitor/share');
  const uri = await writeNative(blob, filename, 'cache');
  await Share.share({ title, files: [uri], dialogTitle: title });
}

/** Save a file: browser download, or the Documents folder on native apps. */
export async function download(blob: Blob, filename: string): Promise<void> {
  if (isNative()) {
    try {
      await writeNative(blob, filename, 'documents');
      toast(`Saved to Documents/${filename}`);
    } catch {
      // Some Android versions restrict Documents; fall back to the share sheet.
      await shareNative(blob, filename, filename);
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Share via the native share sheet when possible, otherwise download. */
export async function shareOrDownload(blob: Blob, filename: string, title: string): Promise<'shared' | 'downloaded'> {
  if (isNative()) {
    try {
      await shareNative(blob, filename, title);
    } catch (e) {
      if (!/cancel/i.test(String((e as Error)?.message))) throw e;
    }
    return 'shared';
  }
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  await download(blob, filename);
  return 'downloaded';
}
