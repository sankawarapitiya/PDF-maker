import { deletePage, getDoc, getPage, refreshDocCache } from '../db';
import { detectDocument, insetQuad, scaleQuad, type FilterName } from '../imaging';
import { blobToImg } from '../raster';
import { events, ocrProgress, reprocess, runOcr } from '../pipeline';
import { back, navigate } from '../router';
import { safeName, shareOrDownload } from '../share';
import { actionButton, confirmDialog, h, iconButton, toast } from '../ui';
import { cropEditor } from './crop';
import { movePage } from './doc';
import type { Page } from '../types';

const FILTERS: [FilterName, string][] = [
  ['original', 'Original'],
  ['enhance', 'Magic color'],
  ['gray', 'Grayscale'],
  ['bw', 'B & W'],
];

export async function pageView([docId, pageId]: string[]) {
  const doc = await getDoc(docId);
  let page = await getPage(pageId);
  if (!doc || !page) {
    navigate(doc ? `/doc/${docId}` : '/', true);
    return { el: h('div') };
  }
  let url = '';
  let showBoxes = false;
  const img = h('img', { class: 'page-img', alt: 'Scanned page' });
  const boxes = h('div', { class: 'word-boxes' });
  const figure = h('div', { class: 'page-figure' }, img, boxes);
  const busyEl = h('div', { class: 'busy-veil', hidden: true }, h('div', { class: 'spinner' }));
  const stage = h('div', { class: 'page-stage' }, figure, busyEl);
  const chips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Filter' });
  const textArea = h('textarea', { class: 'ocr-text', readOnly: true, 'aria-label': 'Recognised text', placeholder: 'No text recognised yet.' });
  const ocrStatus = h('div', { class: 'ocr-status' });
  const position = h('span', { class: 'muted' });
  const textPanel = h(
    'section',
    { class: 'text-panel' },
    h(
      'div',
      { class: 'text-panel-head' },
      h('strong', null, 'Recognised text'),
      h('div', { class: 'spacer' }),
      iconButton('boxes', 'Show word boxes', () => {
        showBoxes = !showBoxes;
        renderBoxes();
      }),
      iconButton('copy', 'Copy text', async () => {
        if (!page!.ocr?.text) return toast('No text yet');
        await navigator.clipboard.writeText(page!.ocr.text);
        toast('Text copied');
      }),
      iconButton('ocr', 'Run OCR again', () => doOcr()),
    ),
    ocrStatus,
    textArea,
  );

  function render() {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(page!.processed);
    img.src = url;
    chips.replaceChildren(
      ...FILTERS.map(([f, label]) =>
        h('button', { class: `chip ${page!.filter === f ? 'on' : ''}`, role: 'radio', 'aria-checked': String(page!.filter === f), onClick: () => edit({ filter: f }) }, label),
      ),
    );
    const idx = doc!.pageIds.indexOf(page!.id);
    position.textContent = `Page ${idx + 1} of ${doc!.pageIds.length}`;
    renderText();
    renderBoxes();
  }

  function renderText() {
    const prog = ocrProgress(page!.id);
    textArea.value = page!.ocr?.text ?? '';
    if (prog !== undefined) ocrStatus.textContent = `Recognising… ${Math.round(prog * 100)}%`;
    else if (page!.ocr) ocrStatus.textContent = `${page!.ocr.words.length} words · ${page!.ocr.confidence}% confidence`;
    else ocrStatus.textContent = '';
  }

  function renderBoxes() {
    boxes.replaceChildren();
    if (!showBoxes || !page!.ocr) return;
    const { width, height, words } = page!.ocr;
    for (const w of words) {
      const [x0, y0, x1, y1] = w.bbox;
      boxes.appendChild(
        h('span', {
          class: `wbox ${w.conf < 60 ? 'low' : ''}`,
          title: `${w.text} (${w.conf}%)`,
          style: `left:${(x0 / width) * 100}%;top:${(y0 / height) * 100}%;width:${((x1 - x0) / width) * 100}%;height:${((y1 - y0) / height) * 100}%`,
        }),
      );
    }
  }

  async function edit(changes: Parameters<typeof reprocess>[1]) {
    busyEl.hidden = false;
    try {
      const hadOcr = !!page!.ocr;
      page = await reprocess(page!, changes);
      await refreshDocCache(doc!);
      render();
      if (hadOcr && !page.ocr) doOcr();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`);
    } finally {
      busyEl.hidden = true;
    }
  }

  async function doOcr() {
    try {
      const p = await runOcr(page!.id, doc!.id);
      if (p) page = p;
      render();
    } catch (e) {
      toast(`OCR failed: ${(e as Error).message}`);
    }
  }

  const onOcr = (e: Event) => {
    if ((e as CustomEvent).detail.pageId !== page!.id) return;
    if ((e as CustomEvent).detail.done) getPage(page!.id).then((p) => { if (p) { page = p; render(); } });
    else renderText();
  };
  events.addEventListener('ocr', onOcr);

  async function recrop() {
    const small = await blobToImg(page!.original, 320);
    const q = detectDocument(small);
    const editor = cropEditor({
      image: page!.original,
      width: page!.originalWidth,
      height: page!.originalHeight,
      quad: page!.quad,
      autoQuad: q ? insetQuad(scaleQuad(q, page!.originalWidth / small.width), 0.012) : undefined,
      title: 'Crop',
      onCancel: () => editor.remove(),
      actions: [{ label: 'Apply', icon: 'check', primary: true, run: (quad) => { editor.remove(); edit({ quad }); } }],
    });
    editor.classList.add('overlay-screen');
    el.appendChild(editor);
    editor.querySelector('.btn.ghost')!.textContent = 'Cancel';
  }

  const el = h(
    'div',
    { class: 'screen page-screen' },
    h(
      'header',
      { class: 'topbar' },
      iconButton('back', 'Back', () => back(`/doc/${docId}`)),
      h('h2', null, position),
      h('div', { class: 'spacer' }),
      iconButton('left', 'Move page earlier', async () => { await movePage(docId, page!.id, -1); Object.assign(doc!, await getDoc(docId)); render(); }),
      iconButton('right', 'Move page later', async () => { await movePage(docId, page!.id, 1); Object.assign(doc!, await getDoc(docId)); render(); }),
      iconButton('trash', 'Delete page', async () => {
        if (!(await confirmDialog('Delete this page?'))) return;
        doc!.pageIds = doc!.pageIds.filter((x) => x !== page!.id);
        await deletePage(page!.id);
        await refreshDocCache(doc!);
        navigate(`/doc/${docId}`, true);
      }),
    ),
    stage,
    chips,
    h(
      'nav',
      { class: 'action-bar compact' },
      actionButton('rotl', 'Left', () => edit({ rotation: (page!.rotation + 3) % 4 })),
      actionButton('rotr', 'Right', () => edit({ rotation: (page!.rotation + 1) % 4 })),
      actionButton('crop', 'Crop', recrop),
      actionButton('ocr', 'OCR', doOcr),
      actionButton('share', 'Image', () => shareOrDownload(page!.processed, `${safeName(doc!.name)}-${doc!.pageIds.indexOf(page!.id) + 1}.jpg`, doc!.name)),
    ),
    textPanel,
  );
  render();
  return {
    el,
    destroy() {
      events.removeEventListener('ocr', onOcr);
      if (url) URL.revokeObjectURL(url);
    },
  };
}

export type { Page };
