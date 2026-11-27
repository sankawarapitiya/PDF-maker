/**
 * Word (.docx) import / export.
 * - Import: mammoth converts .docx → HTML (headings, lists, tables, images, bold/italic…)
 * - Export: the editor's ProseMirror JSON is mapped to a real Word document with `docx`
 */
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType, type IParagraphOptions, type ParagraphChild,
} from 'docx';

interface PMMark { type: string; attrs?: Record<string, unknown> }
interface PMNode { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: PMMark[] }

export async function docxToHtml(data: ArrayBuffer): Promise<{ html: string; warnings: string[] }> {
  const mammoth = (await import('mammoth')).default;
  const r = await mammoth.convertToHtml({ arrayBuffer: data }, {
    styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh", "p[style-name='Quote'] => blockquote > p:fresh"],
  });
  return { html: r.value, warnings: r.messages.map((m: { message: string }) => m.message) };
}

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED,
};
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

/** CSS colour → 6-digit hex (docx wants "RRGGBB"). */
function hexColor(c: unknown): string | undefined {
  if (typeof c !== 'string' || !c) return undefined;
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((x) => x + x).join('').toUpperCase();
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  return undefined;
}

/** "14px" / "12pt" → half-points. */
function halfPoints(size: unknown): number | undefined {
  if (typeof size !== 'string') return undefined;
  const m = /^([\d.]+)(px|pt)?$/.exec(size.trim());
  if (!m) return undefined;
  const pt = m[2] === 'pt' ? Number(m[1]) : Number(m[1]) * 0.75;
  return Math.round(pt * 2);
}

function firstFont(f: unknown): string | undefined {
  if (typeof f !== 'string' || !f) return undefined;
  return f.split(',')[0].replace(/["']/g, '').trim() || undefined;
}

interface Ctx {
  images: Map<string, { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp'; width: number; height: number }>;
  orderedInstance: number;
}

function runs(nodes: PMNode[] | undefined, extra: { bold?: boolean } = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }));
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const marks = n.marks ?? [];
    const has = (t: string) => marks.some((m) => m.type === t);
    const style = marks.find((m) => m.type === 'textStyle')?.attrs ?? {};
    const hl = marks.find((m) => m.type === 'highlight');
    const link = marks.find((m) => m.type === 'link');
    const run = new TextRun({
      text: n.text,
      bold: has('bold') || extra.bold,
      italics: has('italic'),
      underline: has('underline') || link ? {} : undefined,
      strike: has('strike'),
      color: link ? '0563C1' : hexColor(style.color),
      size: halfPoints(style.fontSize),
      font: firstFont(style.fontFamily) ?? (has('code') ? 'Courier New' : undefined),
      shading: hl ? { type: ShadingType.CLEAR, color: 'auto', fill: hexColor(hl.attrs?.color) ?? 'FFF59D' } : undefined,
    });
    const href = link?.attrs?.href;
    if (typeof href === 'string' && /^(https?:|mailto:)/i.test(href)) out.push(new ExternalHyperlink({ link: href, children: [run] }));
    else out.push(run);
  }
  return out;
}

function paragraphOpts(n: PMNode): Partial<IParagraphOptions> {
  const a = n.attrs?.textAlign as string | undefined;
  return a && ALIGN[a] ? { alignment: ALIGN[a] } : {};
}

function blocks(nodes: PMNode[] | undefined, ctx: Ctx, list?: { kind: 'bullet' | 'ordered'; level: number; instance: number }, quote = false): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const quoteOpts: Partial<IParagraphOptions> = quote
    ? { indent: { left: 720 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: '0F766E', space: 8 } } }
    : {};
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'paragraph': {
        const listOpts: Partial<IParagraphOptions> = list
          ? list.kind === 'bullet'
            ? { bullet: { level: list.level } }
            : { numbering: { reference: 'ordered', level: list.level, instance: list.instance } }
          : {};
        out.push(new Paragraph({ ...paragraphOpts(n), ...listOpts, ...quoteOpts, children: runs(n.content) }));
        break;
      }
      case 'heading': {
        const lvl = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
        out.push(new Paragraph({ ...paragraphOpts(n), heading: HEADINGS[lvl - 1], children: runs(n.content) }));
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        const kind = n.type === 'bulletList' ? 'bullet' : 'ordered';
        const level = list ? Math.min(8, list.level + 1) : 0;
        const instance = kind === 'ordered' && !list ? ++ctx.orderedInstance : list?.instance ?? ++ctx.orderedInstance;
        for (const item of n.content ?? []) out.push(...blocks(item.content, ctx, { kind, level, instance }, quote));
        break;
      }
      case 'blockquote':
        out.push(...blocks(n.content, ctx, list, true));
        break;
      case 'codeBlock':
        for (const line of (n.content?.map((c) => c.text ?? '').join('') ?? '').split('\n'))
          out.push(new Paragraph({ shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F4' }, children: [new TextRun({ text: line, font: 'Courier New', size: 20 })] }));
        break;
      case 'horizontalRule':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } }, children: [] }));
        break;
      case 'image': {
        const img = ctx.images.get(String(n.attrs?.src));
        if (img) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: img.type, data: img.data, transformation: { width: img.width, height: img.height } })] }));
        break;
      }
      case 'table': {
        const rows = (n.content ?? []).map((row) => new TableRow({
          children: (row.content ?? []).map((cell) => {
            const header = cell.type === 'tableHeader';
            const inner = blocks(cell.content, ctx).map((b) => b);
            return new TableCell({
              columnSpan: Number(cell.attrs?.colspan) || 1,
              rowSpan: Number(cell.attrs?.rowspan) || 1,
              shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E6F4F1' } : undefined,
              children: inner.length ? (header ? (cell.content ?? []).map((p) => new Paragraph({ ...paragraphOpts(p), children: runs(p.content, { bold: true }) })) : inner) : [new Paragraph('')],
            });
          }),
        }));
        if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        out.push(new Paragraph(''));
        break;
      }
      default:
        if (n.content) out.push(...blocks(n.content, ctx, list, quote));
    }
  }
  return out;
}

function collectImages(n: PMNode, acc: string[] = []): string[] {
  if (n.type === 'image' && typeof n.attrs?.src === 'string') acc.push(n.attrs.src);
  n.content?.forEach((c) => collectImages(c, acc));
  return acc;
}

async function loadImage(src: string) {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob);
  const max = 600; // px ≈ full text width on an A4 page
  const s = Math.min(1, max / bmp.width);
  const dims = { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) };
  bmp.close?.();
  const t = blob.type.includes('png') ? 'png' : blob.type.includes('gif') ? 'gif' : blob.type.includes('bmp') ? 'bmp' : 'jpg';
  return { data: new Uint8Array(await blob.arrayBuffer()), type: t as 'png' | 'jpg' | 'gif' | 'bmp', ...dims };
}

/** Editor JSON → .docx Blob. */
export async function jsonToDocx(json: PMNode, title: string): Promise<Blob> {
  const images: Ctx['images'] = new Map();
  for (const src of new Set(collectImages(json))) {
    try {
      images.set(src, await loadImage(src));
    } catch {
      /* skip unreadable image */
    }
  }
  const children = blocks(json.content, { images, orderedInstance: 0 });
  const doc = new Document({
    creator: 'DocScan OCR',
    title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [],
    },
    numbering: {
      config: [{
        reference: 'ordered',
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children: children.length ? children : [new Paragraph('')],
    }],
  });
  return Packer.toBlob(doc);
}

/** Plain OCR text → simple HTML (paragraph per blank-line block). */
export function textToHtml(title: string, text: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => /^--- Page \d+ ---$/.test(p) ? `<h3>${esc(p.replace(/-/g, '').trim())}</h3>` : `<p>${esc(p).replace(/\n/g, '<br>')}</p>`);
  return `<h1>${esc(title)}</h1>${paras.join('')}`;
}
