import { deleteDoc, getDoc, getPages, getSettings, refreshDocCache, saveDoc } from '../db';
import { buildPdf } from '../pdf';
import { events, ocrProgress, runOcr } from '../pipeline';
import { back, navigate } from '../router';
import { download, safeName, shareOrDownload } from '../share';
import { actionButton, actionSheet, confirmDialog, h, icon, iconButton, progressOverlay, promptDialog, toast } from '../ui';
import { importImages } from './scan';
import type { Page } from '../types';
import { shareToWhatsApp } from '../whatsapp';

export async function docView([id]: string[]) {
  const doc = await getDoc(id);
  if (!doc) {
    navigate('/', true);
    return { el: h('div') };
  }
  let pages = await getPages(doc.pageIds);
  const title = h('h2', { class: 'title-edit' }, doc.name);
  const grid = h('div', { class: 'page-grid' });

  const summary = h('div', { class: 'doc-summary' });
  function renderSummary() {
    const withText = pages.filter((p) => p.ocr).length;
    const words = pages.reduce((n, p) => n + (p.ocr?.words.length ?? 0), 0);
    summary.replaceChildren(
      h('span', { class: 'tag-pill' }, icon('pages', 12), `${pages.length} page${pages.length === 1 ? '' : 's'}`),
      withText
        ? h('span', { class: 'tag-pill' }, icon('ocr', 12), `${withText}/${pages.length} searchable · ${words} words`)
        : h('span', { class: 'tag-pill amber' }, 'Text not recognised yet'),
    );
  }

  function renderGrid() {
    renderSummary();
    grid.replaceChildren(
      ...pages.map((p, i) => {
        const prog = ocrProgress(p.id);
        return h(
          'button',
          { class: 'page-tile', onClick: () => navigate(`/page/${doc!.id}/${p.id}`), 'aria-label': `Page ${i + 1}` },
          h('img', { src: p.thumb, alt: '' }),
          h('span', { class: 'page-num' }, String(i + 1)),
          prog !== undefined
            ? h('span', { class: 'ocr-badge busy' }, `OCR ${Math.round(prog * 100)}%`)
            : p.ocr
              ? h('span', { class: 'ocr-badge' }, icon('check', 11), 'Text')
              : null,
        );
      }),
      h(
        'button',
        { class: 'page-tile add', onClick: () => navigate(`/scan/${doc!.id}`), 'aria-label': 'Add page' },
        icon('plus', 36),
        h('span', null, 'Add page'),
      ),
    );
  }
  renderGrid();

  const onOcr = async (e: Event) => {
    const { pageId, done } = (e as CustomEvent).detail;
    if (!doc!.pageIds.includes(pageId)) return;
    if (done) pages = await getPages(doc!.pageIds);
    renderGrid();
  };
  events.addEventListener('ocr', onOcr);

  async function exportPdf(share: boolean) {
    if (!pages.length) return toast('No pages to export');
    const blob = await makePdf();
    if (!blob) return;
    const name = `${safeName(doc!.name)}.pdf`;
    if (share) await shareOrDownload(blob, name, doc!.name);
    else await download(blob, name);
  }

  async function makePdf(): Promise<Blob | null> {
    const s = await getSettings();
    const pr = progressOverlay('Creating PDF…');
    try {
      return await buildPdf(pages, { size: s.pageSize, title: doc!.name });
    } catch (e) {
      console.error(e);
      toast('PDF export failed');
      return null;
    } finally {
      pr.close();
    }
  }

  async function whatsApp() {
    if (!pages.length) return toast('No pages to send');
    const choice = await actionSheet('Send to WhatsApp', [
      { label: 'PDF document', icon: 'pdf', hint: `${pages.length} page${pages.length > 1 ? 's' : ''}, searchable` },
      { label: 'Page images', icon: 'image', hint: 'JPG photo for each page' },
      { label: 'Recognised text', icon: 'text', hint: 'Send as a message' },
    ]);
    if (choice === null) return;
    const base = safeName(doc!.name);
    try {
      let r;
      if (choice === 0) {
        const blob = await makePdf();
        if (!blob) return;
        r = await shareToWhatsApp([{ blob, name: `${base}.pdf` }]);
      } else if (choice === 1) {
        r = await shareToWhatsApp(pages.map((p, i) => ({ blob: p.processed, name: `${base}-${i + 1}.jpg` })));
      } else {
        const text = pages.map((p) => p.ocr?.text ?? '').join('\n\n').trim();
        if (!text) return toast('No text recognised yet — tap Text first');
        r = await shareToWhatsApp([], text);
      }
      if (r === 'downloaded') toast('Saved — attach the file in WhatsApp');
    } catch (e) {
      const msg = (e as Error).message ?? '';
      toast(/not installed/i.test(msg) ? 'WhatsApp is not installed' : `Could not share: ${msg}`);
    }
  }

  async function ocrAll() {
    const todo = pages.filter((p) => !p.ocr);
    if (!todo.length) return navigate(`/text/${doc!.id}`);
    const pr = progressOverlay(`Recognising text (0/${todo.length})…`);
    try {
      for (let i = 0; i < todo.length; i++) {
        pr.update(i / todo.length, `Recognising text (${i + 1}/${todo.length})…`);
        await runOcr(todo[i].id, doc!.id);
      }
      pages = await getPages(doc!.pageIds);
      renderGrid();
      pr.close();
      navigate(`/text/${doc!.id}`);
    } catch (e) {
      pr.close();
      toast(`OCR failed: ${(e as Error).message}`);
    }
  }

  const el = h(
    'div',
    { class: 'screen doc-screen' },
    h(
      'header',
      { class: 'topbar' },
      iconButton('back', 'Back', () => back('/')),
      title,
      iconButton('edit', 'Rename', async () => {
        const name = await promptDialog('Rename document', doc!.name);
        if (!name) return;
        doc!.name = name;
        await saveDoc(doc!);
        title.textContent = name;
      }),
      iconButton('trash', 'Delete document', async () => {
        if (!(await confirmDialog(`Delete “${doc!.name}” and all its pages?`))) return;
        await deleteDoc(doc!.id);
        navigate('/', true);
      }),
    ),
    h('main', { class: 'content' }, summary, grid),
    h(
      'nav',
      { class: 'action-bar' },
      actionButton('image', 'Import', async () => {
        await importImages(doc!.id);
        const fresh = await getDoc(doc!.id);
        if (fresh) Object.assign(doc!, fresh);
        pages = await getPages(doc!.pageIds);
        renderGrid();
      }),
      actionButton('text', 'Text', ocrAll),
      actionButton('pdf', 'Save PDF', () => exportPdf(false)),
      actionButton('whatsapp', 'WhatsApp', whatsApp, 'wa'),
      actionButton('share', 'Share', () => exportPdf(true), 'primary'),
    ),
  );
  return {
    el,
    destroy: () => events.removeEventListener('ocr', onOcr),
  };
}

export async function movePage(docId: string, pageId: string, delta: number): Promise<number> {
  const doc = await getDoc(docId);
  if (!doc) return -1;
  const i = doc.pageIds.indexOf(pageId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= doc.pageIds.length) return i;
  [doc.pageIds[i], doc.pageIds[j]] = [doc.pageIds[j], doc.pageIds[i]];
  await refreshDocCache(doc);
  return j;
}

export type { Page };
