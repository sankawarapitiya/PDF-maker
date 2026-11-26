import { deleteDoc, getPages, getSettings, listDocs, saveDoc } from '../db';
import { buildPdf } from '../pdf';
import { navigate } from '../router';
import { safeName, shareOrDownload } from '../share';
import { actionSheet, confirmDialog, formatDate, h, icon, iconButton, progressOverlay, promptDialog, toast } from '../ui';
import { importImages } from './scan';
import type { Doc } from '../types';

const logoUrl = new URL('icons/icon.svg', new URL(import.meta.env.BASE_URL, location.href)).href;

/** Brand mark used in headers. */
export function brand(): HTMLElement {
  return h('h1', null, h('img', { src: logoUrl, alt: '', class: 'brand-logo' }), h('span', { class: 'wordmark' }, 'Doc', h('span', null, 'Scan')));
}

/** Empty-state illustration in the brand palette (pages + scan beam). */
function emptyArt(): HTMLElement {
  return h('div', {
    class: 'empty-art',
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 180 150" width="180" height="150">
      <ellipse cx="90" cy="138" rx="62" ry="7" fill="currentColor" opacity=".08"/>
      <rect x="52" y="22" width="76" height="98" rx="10" transform="rotate(-8 90 71)" fill="var(--accent-soft)" stroke="var(--border)"/>
      <rect x="54" y="18" width="76" height="100" rx="10" fill="var(--surface)" stroke="var(--border)" stroke-width="1.5"/>
      <rect x="66" y="34" width="34" height="7" rx="3.5" fill="var(--teal-700)"/>
      <rect x="66" y="50" width="52" height="5" rx="2.5" fill="var(--teal-500)" opacity=".45"/>
      <rect x="66" y="61" width="52" height="5" rx="2.5" fill="var(--teal-500)" opacity=".45"/>
      <rect x="66" y="72" width="38" height="5" rx="2.5" fill="var(--teal-500)" opacity=".45"/>
      <rect x="66" y="94" width="44" height="5" rx="2.5" fill="var(--teal-500)" opacity=".2"/>
      <rect x="40" y="82" width="104" height="4" rx="2" fill="var(--amber-500)"/>
      <rect x="40" y="81" width="104" height="6" rx="3" fill="var(--amber-500)" opacity=".3"/>
      <g fill="none" stroke="var(--teal-600)" stroke-width="4" stroke-linecap="round">
        <path d="M36 26v-8a6 6 0 0 1 6-6h8M130 12h8a6 6 0 0 1 6 6v8M144 112v8a6 6 0 0 1-6 6h-8M50 126h-8a6 6 0 0 1-6-6v-8"/>
      </g></svg>`,
  });
}

function snippetEl(text: string, q: string): HTMLElement | null {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  const clean = (s: string) => s.replace(/\s+/g, ' ');
  return h(
    'p',
    { class: 'snippet' },
    (start > 0 ? '…' : '') + clean(text.slice(start, i)),
    h('mark', null, text.slice(i, i + q.length)),
    clean(text.slice(i + q.length, i + q.length + 60)) + '…',
  );
}

export async function libraryView() {
  let docs = await listDocs();
  const list = h('ul', { class: 'doc-list' });
  const stats = h('div', { class: 'stats' });
  const countLabel = h('small');
  const search = h('input', {
    class: 'input search', type: 'search', placeholder: 'Search documents and text', 'aria-label': 'Search',
    onInput: () => renderList(),
  });

  function renderStats() {
    const pages = docs.reduce((n, d) => n + d.pageIds.length, 0);
    const searchable = docs.filter((d) => d.text).length;
    stats.replaceChildren(
      h('div', { class: 'stat' }, h('strong', null, String(docs.length)), h('small', null, 'Documents')),
      h('div', { class: 'stat' }, h('strong', null, String(pages)), h('small', null, 'Pages')),
      h('div', { class: 'stat' }, h('strong', null, String(searchable)), h('small', null, 'Searchable')),
    );
    stats.hidden = docs.length === 0;
  }

  function renderList() {
    const q = search.value.trim();
    const items: HTMLElement[] = [];
    for (const d of docs) {
      let snip: HTMLElement | null = null;
      if (q) {
        const nameHit = d.name.toLowerCase().includes(q.toLowerCase());
        snip = snippetEl(d.text ?? '', q);
        if (!nameHit && !snip) continue;
      }
      items.push(docItem(d, snip));
    }
    countLabel.textContent = q ? `${items.length} result${items.length === 1 ? '' : 's'}` : docs.length ? `${docs.length}` : '';
    if (items.length) return list.replaceChildren(...items);
    list.replaceChildren(
      h(
        'li',
        { class: 'empty' },
        q
          ? [h('h3', null, 'No matches'), h('p', null, `Nothing found for “${q}”. Try another word from the document.`)]
          : [
              emptyArt(),
              h('h3', null, 'Your scans will appear here'),
              h('p', null, 'Capture a page with the camera or import a photo. Text is recognised automatically so you can search it later.'),
            ],
      ),
    );
  }

  async function docMenu(d: Doc) {
    const choice = await actionSheet(d.name, [
      { label: 'Rename', icon: 'edit' },
      { label: 'Share as PDF', icon: 'share', hint: `${d.pageIds.length} page${d.pageIds.length === 1 ? '' : 's'}` },
      { label: 'Delete', icon: 'trash', hint: 'This cannot be undone', danger: true },
    ]);
    if (choice === 0) {
      const name = await promptDialog('Rename document', d.name);
      if (!name) return;
      d.name = name;
      await saveDoc(d);
      renderList();
    } else if (choice === 1) {
      const pr = progressOverlay('Creating PDF…');
      try {
        const blob = await buildPdf(await getPages(d.pageIds), { size: (await getSettings()).pageSize, title: d.name });
        pr.close();
        await shareOrDownload(blob, `${safeName(d.name)}.pdf`, d.name);
      } catch {
        pr.close();
        toast('PDF export failed');
      }
    } else if (choice === 2) {
      if (!(await confirmDialog(`Delete “${d.name}” and all its pages?`))) return;
      await deleteDoc(d.id);
      docs = docs.filter((x) => x.id !== d.id);
      renderStats();
      renderList();
      toast('Document deleted');
    }
  }

  function docItem(d: Doc, snip: HTMLElement | null) {
    const n = d.pageIds.length;
    return h(
      'li',
      { class: 'doc-item' },
      h(
        'a',
        { href: `#/doc/${d.id}`, class: 'doc-link', onClick: (e: Event) => { e.preventDefault(); navigate(`/doc/${d.id}`); } },
        h(
          'div',
          { class: 'doc-thumb-wrap' },
          d.thumb ? h('img', { src: d.thumb, alt: '', class: 'doc-thumb', loading: 'lazy' }) : h('div', { class: 'doc-thumb placeholder' }, icon('pdf')),
          n > 1 && h('span', { class: 'doc-pages' }, String(n)),
        ),
        h(
          'div',
          { class: 'doc-meta' },
          h('strong', null, d.name),
          h('small', null, icon('clock', 13), formatDate(d.updatedAt)),
          snip ?? (d.text
            ? h('span', { class: 'tag-pill' }, icon('ocr', 12), 'Searchable')
            : h('span', { class: 'tag-pill amber' }, `${n} page${n === 1 ? '' : 's'}`)),
        ),
      ),
      iconButton('more', `Options for ${d.name}`, () => docMenu(d)),
    );
  }

  async function doImport() {
    const id = await importImages();
    if (id) navigate(`/doc/${id}`);
  }

  renderStats();
  renderList();
  const el = h(
    'div',
    { class: 'screen library' },
    h('header', { class: 'topbar' }, brand(), h('div', { class: 'spacer' }), iconButton('settings', 'Settings', () => navigate('/settings'))),
    h(
      'section',
      { class: 'hero' },
      h('h2', null, 'Scan a document'),
      h('p', null, 'Auto-detect edges, enhance the page and turn it into searchable text.'),
      h(
        'div',
        { class: 'hero-actions' },
        h('button', { class: 'btn light', onClick: () => navigate('/scan') }, icon('camera', 20), 'Open camera'),
        h('button', { class: 'btn glass', 'aria-label': 'Import images', onClick: doImport }, icon('image', 20), 'Import'),
      ),
    ),
    stats,
    h('div', { class: 'search-wrap' }, icon('search', 20), search),
    h('main', { class: 'content' }, h('div', { class: 'section-head' }, h('h3', null, 'Recent documents'), countLabel), list),
    h('div', { class: 'fab-row' }, h('button', { class: 'fab', 'aria-label': 'Scan document', onClick: () => navigate('/scan') }, icon('scan', 24), 'Scan')),
  );
  return { el };
}
