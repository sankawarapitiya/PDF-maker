/**
 * Printing: system print dialog (Android print framework → Mopria / Canon /
 * Toshiba print-service plug-ins; browser print on the web; AirPrint via the
 * share sheet on iOS) and direct network printing over IPP / IPPS / raw 9100
 * through the native Android "Printer" plug-in.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { getSettings, saveSettings } from './db';
import { writeTempFile } from './share';
import type { PrintOptions, PrintProtocol, PrinterBrand, PrinterConfig, PrintSettings } from './types';

export interface IppTarget {
  host: string;
  port: number;
  path: string;
  tls: boolean;
  pinnedSha256?: string;
}

export interface PrinterInfo {
  statusCode: number;
  certSha256?: string;
  attrs: Record<string, (string | number | boolean)[]>;
}

export interface DiscoveredPrinter {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  path: string;
  model?: string;
  pdl?: string;
  color?: boolean;
  duplex?: boolean;
}

export interface JobResult {
  statusCode: number;
  jobId?: number;
  jobState?: number;
  message?: string;
}

interface PrinterPlugin {
  printPdf(o: { path: string; name: string; media?: string; color?: string; duplex?: string }): Promise<void>;
  discover(o: { timeoutMs: number }): Promise<{ printers: DiscoveredPrinter[] }>;
  getAttributes(o: IppTarget & { trustOnFirstUse?: boolean }): Promise<PrinterInfo>;
  printJob(o: IppTarget & {
    filePath: string; format: string; jobName: string; user: string; accountId?: string; options: PrintOptions;
  }): Promise<JobResult>;
  jobStatus(o: IppTarget & { jobId: number; user: string }): Promise<{ jobState: number; reasons: string[] }>;
  rawPrint(o: { host: string; port: number; filePath: string; jobName: string; user: string; options: PrintOptions }): Promise<void>;
}

const Native = registerPlugin<PrinterPlugin>('Printer');
export const isAndroid = () => Capacitor.getPlatform() === 'android';
export const canPrintDirect = isAndroid;

export const BRANDS: Record<PrinterBrand, { label: string; ipp: { port: number; path: string }; ipps: { port: number; path: string }; models: string }> = {
  toshiba: { label: 'Toshiba e-STUDIO', ipp: { port: 631, path: '/Print' }, ipps: { port: 443, path: '/Print' }, models: 'e-STUDIO MFPs' },
  canon: { label: 'Canon imageRUNNER / i-SENSYS', ipp: { port: 631, path: '/ipp/print' }, ipps: { port: 443, path: '/ipp/print' }, models: 'imageRUNNER ADVANCE, imageRUNNER, i-SENSYS, imagePRESS' },
  other: { label: 'Other IPP printer', ipp: { port: 631, path: '/ipp/print' }, ipps: { port: 443, path: '/ipp/print' }, models: 'IPP Everywhere / AirPrint / Mopria printers' },
};

export const DEFAULT_OPTIONS: PrintOptions = { copies: 1, color: 'monochrome', sides: 'two-sided-long-edge', media: 'iso_a4_210x297mm' };

export function presetFor(brand: PrinterBrand, protocol: PrintProtocol): { port: number; path: string } {
  if (protocol === 'raw') return { port: 9100, path: '' };
  return BRANDS[brand][protocol];
}

export function guessBrand(model = '', name = ''): PrinterBrand {
  const s = `${model} ${name}`.toLowerCase();
  if (s.includes('toshiba') || s.includes('e-studio')) return 'toshiba';
  if (s.includes('canon') || s.includes('imagerunner') || s.includes('i-sensys')) return 'canon';
  return 'other';
}

/** Hostname or IPv4/IPv6 literal, no scheme/path. */
export function validHost(host: string): boolean {
  const h = host.trim();
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)*[A-Za-z0-9-]{1,63}$/.test(h) || /^\[?[0-9a-fA-F:]+\]?$/.test(h);
}

export const targetOf = (p: PrinterConfig): IppTarget => ({ host: p.host, port: p.port, path: p.path, tls: p.protocol === 'ipps', pinnedSha256: p.certSha256 });

export async function printSettings(): Promise<PrintSettings> {
  return (await getSettings()).printing;
}

export async function savePrinter(p: PrinterConfig): Promise<void> {
  const s = await getSettings();
  const printers = s.printing.printers.filter((x) => x.id !== p.id);
  printers.push(p);
  await saveSettings({ ...s, printing: { printers, defaultPrinterId: s.printing.defaultPrinterId ?? p.id } });
}

export async function removePrinter(id: string): Promise<void> {
  const s = await getSettings();
  const printers = s.printing.printers.filter((x) => x.id !== id);
  await saveSettings({ ...s, printing: { printers, defaultPrinterId: s.printing.defaultPrinterId === id ? printers[0]?.id ?? null : s.printing.defaultPrinterId } });
}

export async function setDefaultPrinter(id: string | null): Promise<void> {
  const s = await getSettings();
  await saveSettings({ ...s, printing: { ...s.printing, defaultPrinterId: id } });
}

export const discover = (timeoutMs = 5000) => Native.discover({ timeoutMs }).then((r) => r.printers);
export const getAttributes = (t: IppTarget, trustOnFirstUse = false) => Native.getAttributes({ ...t, trustOnFirstUse });
export const jobStatus = (p: PrinterConfig, jobId: number) =>
  Native.jobStatus({ ...targetOf(p), jobId, user: p.jobOwner || 'DocScan' });

export const JOB_STATES: Record<number, string> = {
  3: 'Waiting in queue', 4: 'Held at printer', 5: 'Printing…', 6: 'Stopped — check the printer', 7: 'Cancelled', 8: 'Aborted', 9: 'Printed',
};

/** IPP status-code → message. */
export function ippStatusMessage(code: number): string {
  if (code < 0x0100) return 'OK';
  const m: Record<number, string> = {
    0x0400: 'The printer rejected the request',
    0x0401: 'The printer refused the job (forbidden)',
    0x0402: 'The printer requires authentication / a department code',
    0x0403: 'Not authorised on this printer',
    0x0404: 'Print queue not found — check the printer path',
    0x0406: 'Print queue not found — check the printer path',
    0x040a: 'This printer cannot print PDF directly — use the system print dialog',
    0x040b: 'Unsupported option value',
    0x0505: 'This printer does not support the document format',
    0x0506: 'The printer is busy — try again',
    0x0507: 'The printer is not accepting jobs',
  };
  return m[code] ?? `Printer error 0x${code.toString(16).padStart(4, '0')}`;
}

/** Print through the platform's own print dialog. */
export async function systemPrint(pdf: Blob, name: string, o?: Partial<PrintOptions>): Promise<'dialog' | 'shared' | 'browser'> {
  const filename = `${name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'document'}.pdf`;
  if (isAndroid()) {
    const path = await writeTempFile(pdf, filename);
    await Native.printPdf({ path, name, media: o?.media, color: o?.color, duplex: o?.sides });
    return 'dialog';
  }
  if (Capacitor.isNativePlatform()) {
    // iOS: the share sheet offers "Print" (AirPrint).
    const { shareOrDownload } = await import('./share');
    await shareOrDownload(pdf, filename, name);
    return 'shared';
  }
  // Browser: print the PDF from a hidden frame (falls back to opening it).
  const url = URL.createObjectURL(pdf);
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.src = url;
  document.body.appendChild(frame);
  await new Promise<void>((r) => { frame.onload = () => r(); setTimeout(r, 3000); });
  try {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  } catch {
    window.open(url, '_blank');
  }
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
  return 'browser';
}

/** Send a document straight to a network printer (Android app). */
export async function directPrint(p: PrinterConfig, payload: { blob: Blob; format: string; name: string }[], options: PrintOptions): Promise<JobResult[]> {
  if (!canPrintDirect()) throw new Error('Direct network printing is available in the Android app. Use “System print dialog” here.');
  const results: JobResult[] = [];
  for (const [i, part] of payload.entries()) {
    const ext = part.format === 'application/pdf' ? 'pdf' : 'jpg';
    const filePath = await writeTempFile(part.blob, `print-${Date.now()}-${i}.${ext}`);
    if (p.protocol === 'raw') {
      await Native.rawPrint({ host: p.host, port: p.port, filePath, jobName: part.name, user: p.jobOwner || 'DocScan', options });
      results.push({ statusCode: 0 });
      continue;
    }
    const r = await Native.printJob({
      ...targetOf(p), filePath, format: part.format, jobName: part.name,
      user: p.jobOwner || 'DocScan', accountId: p.accountId, options,
    });
    if (r.statusCode >= 0x0400) throw new Error(ippStatusMessage(r.statusCode));
    results.push(r);
  }
  return results;
}
