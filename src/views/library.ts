import {
  createFolder, deleteDoc, deleteFolder, folderPath, getPages, getSettings, listDocs, listFolders, moveDocs, moveFolder,
  saveDoc, saveFolder,
} from '../db';
import { buildPdf } from '../pdf';
import { navigate } from '../router';
import { safeName, shareOrDownload } from '../share';
import { setCurrentFolder } from '../state';
import { actionSheet, confirmDialog, formatDate, h, icon, iconButton, progressOverlay, promptDialog, toast } from '../ui';
import { folderDialog, folderIcon, pickFolder } from './folders';
import { importImages } from './scan';
import { printDoc } from './print';
import type { Doc, Folder } from '../types';

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
  return h('p', { class: 'snippet' },
    (start > 0 ? '…' : '') + clean(text.slice(start, i)),
    h('mark', null, text.slice(i, i + q.length)),
    clean(text.slice(i + q.length, i + q.length + 60)) + '…');
}

/** Word-document thumbnail tile. */
export function wordThumb(): HTMLElement {
  return h('div', { class: 'doc-thumb word-thumb' }, h('span', null, 'W'), h('i'), h('i'), h('i'));
}

const docRoute = (d: Doc) => (d.kind === 'word' ? `/word/${d.id}` : `/doc/${d.id}`);

export async function libraryView([folderId]: string[] = []) {
  let folders = await listFolders();
  let docs = await listDocs();
  const folder = folderId ? folders.find((f) => f.id === folderId) : undefined;
  if (folderId && !folder) {
    navigate('/', true);
    return { el: h('div') };
  }
  const here: string | null = folder?.id ?? null;
  setCurrentFolder(here);

  let selecting = false;
  const selected = new Set<string>();

  const folderGrid = h('div', { class: 'folder-grid' });
  const list = h('ul', { class: 'doc-list' });
  const stats = h('div', { class: 'stats' });
  const countLabel = h('small');
  const selectBtn = h('button', { class: 'link-btn', onClick: () => setSelecting(!selecting) }, 'Select');
  const selectCount = h('strong');
  const selectBar = h('div', { class: 'select-bar', hidden: true },
    iconButton('close', 'Cancel selection', () => setSelecting(false)),
    selectCount,
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn small', onClick: () => moveSelected() }, icon('move', 18), 'Move'),
    h('button', { class: 'btn small danger-outline', onClick: () => deleteSelected() }, icon('trash', 18), 'Delete'));
  const search = h('input', {
    class: 'input search', type: 'search', placeholder: folder ? `Search in ${folder.name}` : 'Search documents and text', 'aria-label': 'Search',
    onInput: () => render(),
  });

  const childFolders = () => folders.filter((f) => f.parentId === here);
  const countIn = (id: string) => docs.filter((d) => d.folderId === id).length + folders.filter((f) => f.parentId === id).length;

  function setSelecting(v: boolean) {
    selecting = v;
    selected.clear();
    selectBtn.textContent = v ? 'Done' : 'Select';
    el.classList.toggle('selecting', v);
    render();
  }
  function updateSelectBar() {
    selectBar.hidden = !selecting;
    selectCount.textContent = `${selected.size} selected`;
    selectBar.querySelectorAll<HTMLButtonElement>('.btn').forEach((b) => (b.disabled = selected.size === 0));
  }

  function renderStats() {
    const pages = docs.reduce((n, d) => n + d.pageIds.length, 0);
    stats.replaceChildren(
      h('div', { class: 'stat' }, h('strong', null, String(docs.length)), h('small', null, 'Documents')),
      h('div', { class: 'stat' }, h('strong', null, String(folders.length)), h('small', null, 'Folders')),
      h('div', { class: 'stat' }, h('strong', null, String(pages)), h('small', null, 'Pages')),
    );
    stats.hidden = docs.length === 0 && folders.length === 0;
  }

  function folderCard(f: Folder) {
    const n = countIn(f.id);
    return h('div', { class: 'folder-card' },
      h('a', { href: `#/folder/${f.id}`, class: 'folder-link', onClick: (e: Event) => { e.preventDefault(); navigate(`/folder/${f.id}`); } },
        folderIcon(f.color, 30),
        h('span', { class: 'folder-name' }, f.name),
        h('small', null, `${n} item${n === 1 ? '' : 's'}`)),
      iconButton('more', `Options for folder ${f.name}`, () => folderMenu(f)));
  }

  function render() {
    const q = search.value.trim();
    // Folders (hidden while searching)
    const subs = childFolders();
    folderGrid.replaceChildren(
      ...subs.map(folderCard),
      h('button', { class: 'folder-card new', onClick: () => newFolder() }, icon('folderplus', 26), h('span', null, 'New folder')),
    );
    folderGrid.parentElement!.hidden = !!q || selecting;

    // Documents: in this folder, or when searching — everywhere below it
    const scope = q ? (here ? descendantsOf(here) : null) : undefined;
    const items: HTMLElement[] = [];
    for (const d of docs) {
      if (scope === undefined && (d.folderId ?? null) !== here) continue;
      if (scope && !scope.has(d.folderId ?? '')) continue;
      let snip: HTMLElement | null = null;
      if (q) {
        const nameHit = d.name.toLowerCase().includes(q.toLowerCase());
        snip = snippetEl(d.text ?? '', q);
        if (!nameHit && !snip) continue;
      }
      items.push(docItem(d, snip, !!q));
    }
    countLabel.textContent = q ? `${items.length} result${items.length === 1 ? '' : 's'}` : items.length ? String(items.length) : '';
    selectBtn.hidden = !items.length && !selecting;
    if (items.length) list.replaceChildren(...items);
    else list.replaceChildren(h('li', { class: `empty ${!q && !folder && docs.length ? 'compact' : ''}` },
      q
        ? [h('h3', null, 'No matches'), h('p', null, `Nothing found for “${q}”.`)]
        : folder
          ? [h('div', { class: 'empty-folder' }, folderIcon(folder.color, 56)), h('h3', null, 'This folder is empty'),
             h('p', null, 'Scan or import into this folder, or move documents here with Select → Move.')]
          : docs.length
            ? [h('p', { class: 'muted' }, 'No documents outside folders. Open a folder above, or scan something new.')]
            : [emptyArt(), h('h3', null, 'Your scans will appear here'),
             h('p', null, 'Capture a page with the camera or import a photo. Text is recognised automatically so you can search it later.')]));
    updateSelectBar();
  }

  function descendantsOf(id: string) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
    return out;
  }

  function docItem(d: Doc, snip: HTMLElement | null, showPath: boolean) {
    const n = d.pageIds.length;
    const isWord = d.kind === 'word';
    const path = showPath && d.folderId ? folderPath(folders, d.folderId).map((f) => f.name).join(' › ') : '';
    const check = h('span', { class: 'doc-check', 'aria-hidden': 'true' }, icon(selected.has(d.id) ? 'checked' : 'unchecked', 22));
    const pill = snip ?? (isWord
      ? h('span', { class: 'tag-pill word' }, 'Word document')
      : d.upload?.status === 'uploaded'
        ? h('span', { class: 'tag-pill' }, icon('cloud', 12), `Uploaded · ${d.upload.remoteDocId}`)
        : d.upload
          ? h('span', { class: 'tag-pill amber' }, icon('upload', 12), d.upload.status === 'failed' ? 'Upload failed' : 'Upload pending')
          : d.text
            ? h('span', { class: 'tag-pill' }, icon('ocr', 12), 'Searchable')
            : h('span', { class: 'tag-pill amber' }, `${n} page${n === 1 ? '' : 's'}`));
    const li = h('li', { class: `doc-item ${selected.has(d.id) ? 'selected' : ''}` },
      h('a', {
        href: `#${docRoute(d)}`, class: 'doc-link',
        onClick: (e: Event) => {
          e.preventDefault();
          if (!selecting) return navigate(docRoute(d));
          if (selected.has(d.id)) selected.delete(d.id);
          else selected.add(d.id);
          li.classList.toggle('selected', selected.has(d.id));
          check.replaceChildren(icon(selected.has(d.id) ? 'checked' : 'unchecked', 22));
          updateSelectBar();
        },
      },
        selecting && check,
        h('div', { class: 'doc-thumb-wrap' },
          isWord ? wordThumb() : d.thumb ? h('img', { src: d.thumb, alt: '', class: 'doc-thumb', loading: 'lazy' }) : h('div', { class: 'doc-thumb placeholder' }, icon('pdf')),
          !isWord && n > 1 && h('span', { class: 'doc-pages' }, String(n))),
        h('div', { class: 'doc-meta' },
          h('strong', null, d.name),
          h('small', null, icon('clock', 13), formatDate(d.updatedAt)),
          path && h('small', { class: 'doc-path' }, icon('foldericon', 12), path),
          pill)),
      !selecting && iconButton('more', `Options for ${d.name}`, () => docMenu(d)));
    return li;
  }

  async function reload() {
    folders = await listFolders();
    docs = await listDocs();
    renderStats();
    render();
  }

  async function newFolder() {
    const r = await folderDialog(folder ? `New folder in ${folder.name}` : 'New folder');
    if (!r) return;
    await createFolder(r.name, here, r.color);
    toast(`Folder “${r.name}” created`);
    reload();
  }

  async function folderMenu(f: Folder) {
    const c = await actionSheet(f.name, [
      { label: 'Open', icon: 'folder' },
      { label: 'Rename & colour', icon: 'edit' },
      { label: 'Move to…', icon: 'move' },
      { label: 'Delete folder', icon: 'trash', danger: true, hint: 'Choose what happens to its contents' },
    ]);
    if (c === 0) navigate(`/folder/${f.id}`);
    else if (c === 1) {
      const r = await folderDialog('Edit folder', f.name, f.color);
      if (!r) return;
      await saveFolder({ ...f, name: r.name, color: r.color });
      reload();
    } else if (c === 2) {
      const dest = await pickFolder(`Move “${f.name}” to`, { exclude: f.id, current: f.parentId });
      if (dest === undefined) return;
      if (!(await moveFolder(f.id, dest))) return toast('A folder can’t be moved inside itself');
      toast('Folder moved');
      reload();
    } else if (c === 3) {
      await removeFolder(f);
      reload();
    }
  }

  async function removeFolder(f: Folder) {
    const n = countIn(f.id);
    if (!n) {
      if (!(await confirmDialog(`Delete the empty folder “${f.name}”?`))) return false;
      await deleteFolder(f.id, 'keep');
      return true;
    }
    const c = await actionSheet(`Delete “${f.name}”?`, [
      { label: 'Delete folder, keep contents', icon: 'up', hint: 'Its items move to the parent folder' },
      { label: 'Delete folder and everything in it', icon: 'trash', danger: true, hint: 'Documents are permanently deleted' },
    ]);
    if (c === null) return false;
    if (c === 1 && !(await confirmDialog(`Permanently delete “${f.name}” and all documents inside it?`, 'Delete all'))) return false;
    await deleteFolder(f.id, c === 0 ? 'keep' : 'all');
    toast('Folder deleted');
    return true;
  }

  async function moveSelected() {
    if (!selected.size) return;
    const dest = await pickFolder(`Move ${selected.size} item${selected.size === 1 ? '' : 's'} to`, { current: here });
    if (dest === undefined) return;
    await moveDocs([...selected], dest);
    const name = dest ? folders.find((f) => f.id === dest)?.name ?? 'folder' : 'Home';
    toast(`Moved to ${name}`);
    setSelecting(false);
    reload();
  }

  async function deleteSelected() {
    if (!selected.size) return;
    if (!(await confirmDialog(`Delete ${selected.size} document${selected.size === 1 ? '' : 's'}? This cannot be undone.`))) return;
    for (const id of selected) await deleteDoc(id);
    toast('Deleted');
    setSelecting(false);
    reload();
  }

  async function docMenu(d: Doc) {
    const isWord = d.kind === 'word';
    const choice = await actionSheet(d.name, [
      { label: 'Rename', icon: 'edit' },
      { label: 'Move to folder', icon: 'move' },
      { label: 'Print', icon: 'printer' },
      { label: isWord ? 'Share as Word (.docx)' : 'Share as PDF', icon: 'share', hint: isWord ? undefined : `${d.pageIds.length} page${d.pageIds.length === 1 ? '' : 's'}` },
      { label: 'Delete', icon: 'trash', hint: 'This cannot be undone', danger: true },
    ]);
    if (choice === 0) {
      const name = await promptDialog('Rename document', d.name);
      if (!name) return;
      d.name = name;
      await saveDoc(d);
      render();
    } else if (choice === 1) {
      const dest = await pickFolder(`Move “${d.name}” to`, { current: d.folderId ?? null });
      if (dest === undefined) return;
      await moveDocs([d.id], dest);
      toast('Moved');
      reload();
    } else if (choice === 2) {
      printDoc(d);
    } else if (choice === 3) {
      if (isWord) return navigate(`/word/${d.id}`);
      const pr = progressOverlay('Creating PDF…');
      try {
        const blob = await buildPdf(await getPages(d.pageIds), { size: (await getSettings()).pageSize, title: d.name });
        pr.close();
        await shareOrDownload(blob, `${safeName(d.name)}.pdf`, d.name);
      } catch {
        pr.close();
        toast('PDF export failed');
      }
    } else if (choice === 4) {
      if (!(await confirmDialog(`Delete “${d.name}”?`))) return;
      await deleteDoc(d.id);
      toast('Document deleted');
      reload();
    }
  }

  async function newMenu() {
    const c = await actionSheet(folder ? `Add to ${folder.name}` : 'Create', [
      { label: 'Scan with camera', icon: 'camera' },
      { label: 'Import images', icon: 'image' },
      { label: 'New Word document', icon: 'fileplus', hint: 'Write and format a .docx document' },
      { label: 'Open Word file', icon: 'filedown', hint: 'Edit an existing .docx' },
      { label: 'New folder', icon: 'folderplus' },
    ]);
    if (c === 0) navigate('/scan');
    else if (c === 1) { const id = await importImages(); if (id) navigate(`/doc/${id}`); }
    else if (c === 2) { const d = await (await import('./word')).createWordDoc(); navigate(`/word/${d.id}`); }
    else if (c === 3) { const d = await (await import('./word')).importDocxFile(); if (d) navigate(`/word/${d.id}`); }
    else if (c === 4) newFolder();
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  const crumbs = folder
    ? h('nav', { class: 'breadcrumb', 'aria-label': 'Folder path' },
        h('a', { href: '#/', onClick: (e: Event) => { e.preventDefault(); navigate('/'); } }, icon('folder', 14), 'Home'),
        ...folderPath(folders, folder.id).flatMap((f, i, arr) => [
          h('span', { class: 'sep' }, '›'),
          i === arr.length - 1 ? h('span', { class: 'cur' }, f.name)
            : h('a', { href: `#/folder/${f.id}`, onClick: (e: Event) => { e.preventDefault(); navigate(`/folder/${f.id}`); } }, f.name),
        ]))
    : null;

  const header = folder
    ? h('header', { class: 'topbar' },
        iconButton('back', 'Back', () => navigate(folder.parentId ? `/folder/${folder.parentId}` : '/')),
        h('h2', { class: 'folder-title' }, folderIcon(folder.color, 22), folder.name),
        iconButton('more', 'Folder options', async () => {
          const c = await actionSheet(folder.name, [
            { label: 'Rename & colour', icon: 'edit' },
            { label: 'Move folder', icon: 'move' },
            { label: 'Delete folder', icon: 'trash', danger: true },
          ]);
          if (c === 0) {
            const r = await folderDialog('Edit folder', folder.name, folder.color);
            if (r) { await saveFolder({ ...folder, ...r }); navigate(`/folder/${folder.id}`, true); }
          } else if (c === 1) {
            const dest = await pickFolder(`Move “${folder.name}” to`, { exclude: folder.id, current: folder.parentId });
            if (dest !== undefined && (await moveFolder(folder.id, dest))) navigate(`/folder/${folder.id}`, true);
          } else if (c === 2 && (await removeFolder(folder))) navigate(folder.parentId ? `/folder/${folder.parentId}` : '/', true);
        }))
    : h('header', { class: 'topbar' }, brand(), h('div', { class: 'spacer' }), iconButton('settings', 'Settings', () => navigate('/settings')));

  const el = h('div', { class: 'screen library' },
    header,
    crumbs,
    !folder && h('section', { class: 'hero' },
      h('h2', null, 'Scan a document'),
      h('p', null, 'Auto-detect edges, enhance the page and turn it into searchable text.'),
      h('div', { class: 'hero-actions' },
        h('button', { class: 'btn light', onClick: () => navigate('/scan') }, icon('camera', 20), 'Open camera'),
        h('button', { class: 'btn glass', 'aria-label': 'Import images', onClick: async () => { const id = await importImages(); if (id) navigate(`/doc/${id}`); } }, icon('image', 20), 'Import'))),
    !folder && stats,
    h('div', { class: 'search-wrap' }, icon('search', 20), search),
    h('main', { class: 'content' },
      h('div', { class: 'folders-section' },
        h('div', { class: 'section-head' }, h('h3', null, folder ? 'Folders' : 'Folders'), h('small')),
        folderGrid),
      h('div', { class: 'section-head' }, h('h3', null, folder ? 'Documents' : 'Recent documents'), h('div', { class: 'head-right' }, countLabel, selectBtn)),
      list),
    selectBar,
    h('div', { class: 'fab-row' },
      h('button', { class: 'fab secondary', 'aria-label': 'Create new', onClick: () => newMenu() }, icon('plus', 26)),
      h('button', { class: 'fab', 'aria-label': 'Scan document', onClick: () => navigate('/scan') }, icon('scan', 24), 'Scan')),
  );
  renderStats();
  render();
  return { el };
}
