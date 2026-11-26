import { jsPDF } from 'jspdf';
import type { Page, PageSize } from './types';
import { blobToDataURL } from './raster';

const SIZES: Record<Exclude<PageSize, 'auto'>, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/**
 * Build a searchable PDF: each page is the scanned image with an invisible
 * OCR text layer positioned over the words, so text can be selected/searched.
 */
export async function buildPdf(pages: Page[], opts: { size: PageSize; title: string }): Promise<Blob> {
  let pdf: jsPDF | null = null;
  for (const page of pages) {
    const imgW = page.width;
    const imgH = page.height;
    let pw: number;
    let ph: number;
    if (opts.size === 'auto') {
      // 150 DPI equivalent page, in points.
      pw = (imgW / 150) * 72;
      ph = (imgH / 150) * 72;
    } else {
      [pw, ph] = SIZES[opts.size];
      if (imgW > imgH) [pw, ph] = [ph, pw];
    }
    const orientation = pw > ph ? 'landscape' : 'portrait';
    if (!pdf) {
      pdf = new jsPDF({ unit: 'pt', format: [pw, ph], orientation, compress: true });
      pdf.setProperties({ title: opts.title, creator: 'DocScan OCR' });
    } else {
      pdf.addPage([pw, ph], orientation);
    }
    // Fit image inside page (centered) preserving aspect ratio.
    const scale = Math.min(pw / imgW, ph / imgH);
    const dw = imgW * scale;
    const dh = imgH * scale;
    const ox = (pw - dw) / 2;
    const oy = (ph - dh) / 2;
    const data = await blobToDataURL(page.processed);
    pdf.addImage(data, 'JPEG', ox, oy, dw, dh, undefined, 'FAST');

    if (page.ocr?.words.length) {
      const sx = dw / page.ocr.width;
      const sy = dh / page.ocr.height;
      for (const w of page.ocr.words) {
        // Non-latin glyphs aren't in the standard fonts; keep text layer ASCII-safe.
        const text = w.text.normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
        if (!text) continue;
        const [x0, y0, x1, y1] = w.bbox;
        const boxW = (x1 - x0) * sx;
        const boxH = (y1 - y0) * sy;
        const fontSize = Math.max(1, boxH);
        pdf.setFontSize(fontSize);
        const natural = pdf.getTextWidth(text);
        pdf.text(text, ox + x0 * sx, oy + y1 * sy, {
          renderingMode: 'invisible',
          baseline: 'bottom',
          horizontalScale: natural > 0 ? boxW / natural : 1,
        });
      }
    }
  }
  if (!pdf) throw new Error('No pages');
  return pdf.output('blob');
}
