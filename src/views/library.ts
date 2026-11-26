import { deleteDoc, listDocs } from '../db';
import { navigate } from '../router';
import { confirmDialog, formatDate, h, icon, iconButton, toast } from '../ui';
import { importImages } from './scan';
import type { Doc } from '../types';

function snippet(text: string, q: string): string | null {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  return (start > 0 ? '…' : '') + text.slice(start, i + q.length + 60).replace(/\s+/g, ' ') + '…';
}

export async function libraryView() {
  let docs = await listDocs();
  const list = h('ul', { class: 'doc-list' });
  const search = h('input', {
    class: 'input search',
    type: 'search',
    placeholder: 'Search documents and scanned text',
    'aria-label': 'Search',
    onInput: () => renderList(),
  });

  function renderList() {
    const q = search.value.trim();
    const items: HTMLElement[] = [];
    for (const d of docs) {
      let snip: string | null = null;
      if (q) {
        const nameHit = d.name.toLowerCase().includes(q.toLowerCase());
        snip = snippet(d.text ?? '', q);
        if (!nameHit && !snip) continue;
      }
      items.push(docItem(d, snip));
    }
    if (!items.length) {
      list.replaceChildren(
        h(
          'li',
          { class: 'empty' },
          q
            ? h('p', null, `No results for “${q}”`)
            : [
                h('div', { class: 'empty-art' }, icon('pdf', 64)),
                h('h3', null, 'No scans yet'),
                h('p', null, 'Tap the camera button to scan your first document. Text is recognised automatically and saved with your scans.'),
              ],
        ),
      );
    } else list.replaceChildren(...items);
  }

  function docItem(d: Doc, snip: string | null) {
    return h(
      'li',
      { class: 'doc-item' },
      h(
        'a',
        { href: `#/doc/${d.id}`, class: 'doc-link', onClick: (e: Event) => { e.preventDefault(); navigate(`/doc/${d.id}`); } },
        d.thumb ? h('img', { src: d.thumb, alt: '', class: 'doc-thumb', loading: 'lazy' }) : h('div', { class: 'doc-thumb placeholder' }, icon('pdf')),
        h(
          'div',
          { class: 'doc-meta' },
          h('strong', null, d.name),
          h('small', null, `${d.pageIds.length} page${d.pageIds.length === 1 ? '' : 's'} · ${formatDate(d.updatedAt)}`),
          snip && h('p', { class: 'snippet' }, snip),
        ),
      ),
      iconButton('trash', `Delete ${d.name}`, async () => {
        if (!(await confirmDialog(`Delete “${d.name}”?`))) return;
        await deleteDoc(d.id);
        docs = docs.filter((x) => x.id !== d.id);
        renderList();
        toast('Document deleted');
      }),
    );
  }

  renderList();
  const el = h(
    'div',
    { class: 'screen library' },
    h(
      'header',
      { class: 'topbar' },
      h('h1', null, h('span', { class: 'logo' }, icon('ocr', 22)), 'DocScan'),
      h('div', { class: 'spacer' }),
      iconButton('settings', 'Settings', () => navigate('/settings')),
    ),
    h('div', { class: 'search-wrap' }, icon('search', 20), search),
    h('main', { class: 'content' }, list),
    h(
      'div',
      { class: 'fab-row' },
      h('button', {
        class: 'fab secondary', 'aria-label': 'Import images',
        onClick: async () => { const id = await importImages(); if (id) navigate(`/doc/${id}`); },
      }, icon('image')),
      h('button', { class: 'fab', 'aria-label': 'Scan document', onClick: () => navigate('/scan') }, icon('camera', 28)),
    ),
  );
  return { el };
}
