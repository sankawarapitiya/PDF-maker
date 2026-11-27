import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import { jsPDF } from 'jspdf';
import { deleteDoc, getDoc, getWord, moveDocs, saveDoc, saveWord, uid } from '../db';
import { docxToHtml, jsonToDocx, textToHtml } from '../docx';
import { back, navigate } from '../router';
import { download, safeName, shareOrDownload } from '../share';
import { getCurrentFolder } from '../state';
import { actionSheet, confirmDialog, h, icon, iconButton, pickFiles, progressOverlay, promptDialog, toast } from '../ui';
import { pickFolder } from './folders';
import { printBlob } from './print';
import type { Doc } from '../types';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function createWordDoc(opts: { name?: string; html?: string; folderId?: string | null } = {}): Promise<Doc> {
  const now = Date.now();
  const doc: Doc = {
    id: uid(), kind: 'word', name: opts.name ?? 'Untitled document', folderId: opts.folderId ?? getCurrentFolder(),
    createdAt: now, updatedAt: now, pageIds: [],
  };
  const html = opts.html ?? '';
  const text = htmlText(html);
  await saveWord(doc.id, { json: null, html, text });
  doc.text = text;
  await saveDoc(doc);
  return doc;
}

const htmlText = (html: string) => {
  const d = document.createElement('div');
  // Keep block boundaries so search snippets don't run words together.
  d.innerHTML = html.replace(/<\/(p|h[1-6]|li|tr|blockquote|div)>|<br\s*\/?>/gi, '$&\n');
  return (d.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
};

/** Pick a .docx from the device and create an editable document from it. */
export async function importDocxFile(): Promise<Doc | null> {
  const [file] = await pickFiles(`.docx,${DOCX_MIME}`, false);
  if (!file) return null;
  if (!/\.docx$/i.test(file.name) && file.type !== DOCX_MIME) {
    toast('Please choose a Word .docx file');
    return null;
  }
  const pr = progressOverlay('Opening Word document…');
  try {
    const { html, warnings } = await docxToHtml(await file.arrayBuffer());
    if (warnings.length) console.info('docx import notes', warnings);
    return await createWordDoc({ name: file.name.replace(/\.docx$/i, ''), html });
  } catch (e) {
    console.error(e);
    toast('Could not read this Word file');
    return null;
  } finally {
    pr.close();
  }
}

/** Turn a scanned document's recognised text into an editable Word document. */
export async function wordFromScan(scan: Doc): Promise<Doc> {
  return createWordDoc({ name: `${scan.name} (text)`, html: textToHtml(scan.name, scan.text ?? ''), folderId: scan.folderId ?? null });
}

/** Render HTML into an A4 PDF (vector text via jsPDF's HTML renderer). */
export async function htmlToPdf(html: string, title: string): Promise<Blob> {
  const holder = h('div', { class: 'word-print-holder' }, h('div', { class: 'ProseMirror word-print', html }));
  document.body.appendChild(holder);
  try {
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    pdf.setProperties({ title, creator: 'DocScan OCR' });
    await new Promise<void>((resolve) =>
      pdf.html(holder.firstElementChild as HTMLElement, {
        x: 0, y: 0, width: 595.28, windowWidth: 794,
        margin: [54, 0, 54, 0],
        autoPaging: 'text',
        html2canvas: { scale: 0.75, useCORS: true, backgroundColor: '#ffffff' },
        callback: () => resolve(),
      }));
    return pdf.output('blob');
  } finally {
    holder.remove();
  }
}

export async function wordPdf(doc: Doc): Promise<Blob> {
  const c = await getWord(doc.id);
  return htmlToPdf(c?.html ?? '', doc.name);
}

const FONTS: [string, string][] = [
  ['', 'Default'], ['Calibri, Carlito, sans-serif', 'Calibri'], ['Arial, Helvetica, sans-serif', 'Arial'],
  ['"Times New Roman", Tinos, serif', 'Times New Roman'], ['Georgia, serif', 'Georgia'], ['"Courier New", monospace', 'Courier New'],
];
const SIZES = ['', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48'];
const COLORS = ['#000000', '#0F766E', '#2563EB', '#DC2626', '#F5A524', '#7C3AED', '#64748B'];

export async function wordView([id]: string[]) {
  const doc = await getDoc(id);
  if (!doc || doc.kind !== 'word') {
    navigate('/', true);
    return { el: h('div') };
  }
  const stored = await getWord(id);
  const status = h('span', { class: 'save-state' }, 'Saved');
  const title = h('h2', { title: 'Rename', onClick: async () => {
    const n = await promptDialog('Rename document', doc!.name);
    if (n) { doc!.name = n; title.textContent = n; await saveDoc(doc!); }
  } }, doc.name);
  const page = h('div', { class: 'word-page' });
  let saveTimer = 0;
  let dirty = false;

  const editor = new Editor({
    element: page,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: true }),
      Image.configure({ allowBase64: true }),
      TableKit.configure({ table: { resizable: false } }),
      TextStyleKit,
      Placeholder.configure({ placeholder: 'Start typing your document…' }),
    ],
    content: (stored?.json as object) ?? stored?.html ?? '',
    editorProps: { attributes: { class: 'word-editor', spellcheck: 'true', 'aria-label': 'Document' } },
    onUpdate: () => {
      dirty = true;
      status.textContent = 'Editing…';
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, 700);
    },
    onSelectionUpdate: () => syncToolbar(),
    onTransaction: () => syncToolbar(),
  });

  async function save() {
    if (!dirty) return;
    dirty = false;
    const html = editor.getHTML();
    const text = editor.getText({ blockSeparator: '\n\n' }).trim();
    await saveWord(id, { json: editor.getJSON(), html, text });
    doc!.text = text;
    await saveDoc(doc!);
    status.textContent = 'Saved';
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────
  const chain = () => editor.chain().focus();
  const tb: { el: HTMLElement; active?: () => boolean }[] = [];
  const btn = (ic: string, label: string, run: () => void, active?: () => boolean) => {
    const b = h('button', { class: 'tb-btn', type: 'button', 'aria-label': label, title: label, onMousedown: (e: Event) => e.preventDefault(), onClick: run }, icon(ic, 20));
    tb.push({ el: b, active });
    return b;
  };
  const sep = () => h('span', { class: 'tb-sep' });

  const styleSel = h('select', { class: 'tb-select', 'aria-label': 'Paragraph style', onChange: () => {
    const v = styleSel.value;
    if (v === 'p') chain().setParagraph().run();
    else chain().toggleHeading({ level: Number(v) as 1 | 2 | 3 }).run();
  } }, [['p', 'Normal'], ['1', 'Heading 1'], ['2', 'Heading 2'], ['3', 'Heading 3']].map(([v, l]) => h('option', { value: v }, l)));
  const fontSel = h('select', { class: 'tb-select', 'aria-label': 'Font', onChange: () => {
    if (fontSel.value) chain().setFontFamily(fontSel.value).run();
    else chain().unsetFontFamily().run();
  } }, FONTS.map(([v, l]) => h('option', { value: v }, l)));
  const sizeSel = h('select', { class: 'tb-select narrow', 'aria-label': 'Font size', onChange: () => {
    if (sizeSel.value) chain().setFontSize(`${sizeSel.value}pt`).run();
    else chain().unsetFontSize().run();
  } }, SIZES.map((v) => h('option', { value: v }, v || 'Size')));

  const colorPop = h('div', { class: 'tb-pop', hidden: true },
    ...COLORS.map((c) => {
      const s = h('button', { class: 'swatch', type: 'button', 'aria-label': `Text colour ${c}`, onMousedown: (e: Event) => e.preventDefault(), onClick: () => { chain().setColor(c).run(); colorPop.hidden = true; } });
      s.style.background = c;
      return s;
    }),
    h('button', { class: 'tb-btn', type: 'button', 'aria-label': 'Remove colour', onClick: () => { chain().unsetColor().run(); colorPop.hidden = true; } }, icon('close', 16)));

  const tableBtns = h('div', { class: 'tb-group table-tools', hidden: true },
    btn('rows', 'Add row', () => chain().addRowAfter().run()),
    btn('cols', 'Add column', () => chain().addColumnAfter().run()),
    h('button', { class: 'tb-btn text', type: 'button', onClick: () => chain().deleteRow().run() }, '−Row'),
    h('button', { class: 'tb-btn text', type: 'button', onClick: () => chain().deleteColumn().run() }, '−Col'),
    h('button', { class: 'tb-btn text danger', type: 'button', onClick: () => chain().deleteTable().run() }, 'Delete table'));

  const toolbar = h('div', { class: 'word-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    btn('undo', 'Undo', () => chain().undo().run()),
    btn('redo', 'Redo', () => chain().redo().run()),
    sep(), styleSel, fontSel, sizeSel, sep(),
    btn('bold', 'Bold', () => chain().toggleBold().run(), () => editor.isActive('bold')),
    btn('italic', 'Italic', () => chain().toggleItalic().run(), () => editor.isActive('italic')),
    btn('underline', 'Underline', () => chain().toggleUnderline().run(), () => editor.isActive('underline')),
    btn('strike', 'Strikethrough', () => chain().toggleStrike().run(), () => editor.isActive('strike')),
    h('span', { class: 'tb-color' }, btn('color', 'Text colour', () => (colorPop.hidden = !colorPop.hidden)), colorPop),
    btn('highlight', 'Highlight', () => chain().toggleHighlight({ color: '#FEF08A' }).run(), () => editor.isActive('highlight')),
    sep(),
    btn('alignleft', 'Align left', () => chain().setTextAlign('left').run(), () => editor.isActive({ textAlign: 'left' })),
    btn('aligncenter', 'Center', () => chain().setTextAlign('center').run(), () => editor.isActive({ textAlign: 'center' })),
    btn('alignright', 'Align right', () => chain().setTextAlign('right').run(), () => editor.isActive({ textAlign: 'right' })),
    btn('alignjustify', 'Justify', () => chain().setTextAlign('justify').run(), () => editor.isActive({ textAlign: 'justify' })),
    sep(),
    btn('ul', 'Bulleted list', () => chain().toggleBulletList().run(), () => editor.isActive('bulletList')),
    btn('ol', 'Numbered list', () => chain().toggleOrderedList().run(), () => editor.isActive('orderedList')),
    btn('quote', 'Quote', () => chain().toggleBlockquote().run(), () => editor.isActive('blockquote')),
    btn('hr', 'Horizontal line', () => chain().setHorizontalRule().run()),
    sep(),
    btn('table', 'Insert table', () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
    btn('imageplus', 'Insert picture', async () => {
      const [f] = await pickFiles('image/*', false);
      if (!f) return;
      const src = await shrinkImage(f);
      chain().setImage({ src }).run();
    }),
    btn('link', 'Link', async () => {
      const prev = editor.getAttributes('link').href as string | undefined;
      const url = await promptDialog('Link address', prev ?? 'https://');
      if (url === null) return;
      if (!url || url === 'https://') chain().unsetLink().run();
      else if (/^(https?:|mailto:)/i.test(url)) chain().extendMarkRange('link').setLink({ href: url }).run();
      else toast('Links must start with https:// or mailto:');
    }, () => editor.isActive('link')),
    tableBtns,
  );

  function syncToolbar() {
    for (const t of tb) if (t.active) t.el.classList.toggle('on', t.active());
    styleSel.value = editor.isActive('heading', { level: 1 }) ? '1' : editor.isActive('heading', { level: 2 }) ? '2' : editor.isActive('heading', { level: 3 }) ? '3' : 'p';
    const ts = editor.getAttributes('textStyle');
    fontSel.value = FONTS.some(([v]) => v === ts.fontFamily) ? ts.fontFamily : '';
    sizeSel.value = typeof ts.fontSize === 'string' ? ts.fontSize.replace(/pt$/, '') : '';
    if (!SIZES.includes(sizeSel.value)) sizeSel.value = '';
    tableBtns.hidden = !editor.isActive('table');
  }

  // ── Document actions ────────────────────────────────────────────────────
  async function docxBlob() {
    await save();
    return jsonToDocx(editor.getJSON() as never, doc!.name);
  }
  async function pdfBlob() {
    await save();
    return htmlToPdf(editor.getHTML(), doc!.name);
  }
  async function menu() {
    const c = await actionSheet(doc!.name, [
      { label: 'Save as Word (.docx)', icon: 'save', hint: 'Download to this device' },
      { label: 'Share Word file', icon: 'share' },
      { label: 'Export PDF', icon: 'pdf' },
      { label: 'Print', icon: 'printer' },
      { label: 'Rename', icon: 'edit' },
      { label: 'Move to folder', icon: 'move' },
      { label: 'Delete document', icon: 'trash', danger: true },
    ]);
    const name = safeName(doc!.name);
    try {
      if (c === 0) { await download(await docxBlob(), `${name}.docx`); toast('Word file saved'); }
      else if (c === 1) await shareOrDownload(await docxBlob(), `${name}.docx`, doc!.name);
      else if (c === 2) {
        const pr = progressOverlay('Creating PDF…');
        try { await download(await pdfBlob(), `${name}.pdf`); } finally { pr.close(); }
      } else if (c === 3) {
        const pr = progressOverlay('Preparing to print…');
        let blob: Blob;
        try { blob = await pdfBlob(); } finally { pr.close(); }
        await printBlob(blob, doc!.name);
      } else if (c === 4) {
        const n = await promptDialog('Rename document', doc!.name);
        if (n) { doc!.name = n; title.textContent = n; await saveDoc(doc!); }
      } else if (c === 5) {
        const dest = await pickFolder(`Move “${doc!.name}” to`, { current: doc!.folderId ?? null });
        if (dest !== undefined) { await moveDocs([doc!.id], dest); doc!.folderId = dest; toast('Moved'); }
      } else if (c === 6) {
        if (!(await confirmDialog(`Delete “${doc!.name}”?`))) return;
        await deleteDoc(doc!.id);
        navigate(doc!.folderId ? `/folder/${doc!.folderId}` : '/', true);
      }
    } catch (e) {
      console.error(e);
      toast('Something went wrong — please try again');
    }
  }

  const el = h('div', { class: 'screen word-screen' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Back', async () => { await save(); back(doc!.folderId ? `/folder/${doc!.folderId}` : '/'); }),
      h('div', { class: 'word-title' }, title, status),
      iconButton('save', 'Save as Word', async () => { await download(await docxBlob(), `${safeName(doc!.name)}.docx`); toast('Word file saved'); }),
      iconButton('more', 'Document options', menu)),
    toolbar,
    h('main', { class: 'word-canvas' }, page),
  );
  syncToolbar();
  const onHide = () => { if (document.hidden) save(); };
  document.addEventListener('visibilitychange', onHide);
  return {
    el,
    destroy() {
      clearTimeout(saveTimer);
      save().finally(() => editor.destroy());
      document.removeEventListener('visibilitychange', onHide);
    },
  };
}

/** Downscale pictures before embedding so documents stay small. */
async function shrinkImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.85);
}
