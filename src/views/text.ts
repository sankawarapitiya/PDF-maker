import { getDoc, getPages } from '../db';
import { back, navigate } from '../router';
import { safeName, shareOrDownload } from '../share';
import { actionButton, h, iconButton, toast } from '../ui';

export async function textView([id]: string[]) {
  const doc = await getDoc(id);
  if (!doc) {
    navigate('/', true);
    return { el: h('div') };
  }
  const pages = await getPages(doc.pageIds);
  const full = pages.map((p, i) => `— Page ${i + 1} —\n${p.ocr?.text ?? '(no text recognised)'}`).join('\n\n');
  const area = h('textarea', { class: 'ocr-text full', 'aria-label': 'Document text' });
  area.value = full;
  const words = pages.reduce((n, p) => n + (p.ocr?.words.length ?? 0), 0);
  const el = h(
    'div',
    { class: 'screen text-screen' },
    h(
      'header',
      { class: 'topbar' },
      iconButton('back', 'Back', () => back(`/doc/${id}`)),
      h('h2', null, `${doc.name} — text`),
    ),
    h('main', { class: 'content' }, h('p', { class: 'muted' }, `${pages.length} pages · ${words} words. You can edit before copying or sharing.`), area),
    h(
      'nav',
      { class: 'action-bar' },
      actionButton('copy', 'Copy', async () => {
        await navigator.clipboard.writeText(area.value);
        toast('Copied to clipboard');
      }),
      actionButton('share', 'Share .txt', () =>
        shareOrDownload(new Blob([area.value], { type: 'text/plain' }), `${safeName(doc.name)}.txt`, doc.name), 'primary'),
    ),
  );
  return { el };
}
