import { createStore, get, set, del, getMany, delMany } from 'idb-keyval';
import type { Doc, Folder, Page, Settings } from './types';

const docsStore = createStore('docscan-docs', 'docs');
const pagesStore = createStore('docscan-pages', 'pages');
const metaStore = createStore('docscan-meta', 'meta');

export const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export const DEFAULT_SETTINGS: Settings = {
  server: {
    enabled: false,
    url: '',
    authMethod: 'token',
    username: '',
    docIdPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$',
    includeText: true,
    deleteAfterUpload: false,
  },
  security: { lockEnabled: false, autoLockMinutes: 1, blockScreenshots: false },
  printing: { printers: [], defaultPrinterId: null },
  ocrLangs: ['eng'],
  autoOcr: true,
  autoCapture: false,
  defaultFilter: 'enhance',
  pageSize: 'auto',
  jpegQuality: 0.85,
};

export async function getSettings(): Promise<Settings> {
  const saved: Partial<Settings> = (await get('settings', metaStore)) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    server: { ...DEFAULT_SETTINGS.server, ...saved.server },
    security: { ...DEFAULT_SETTINGS.security, ...saved.security },
    printing: { ...DEFAULT_SETTINGS.printing, ...saved.printing },
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await set('settings', s, metaStore);
}

export async function listDocs(): Promise<Doc[]> {
  const ids: string[] = (await get('index', metaStore)) ?? [];
  const docs = (await getMany<Doc | undefined>(ids, docsStore)).filter(Boolean) as Doc[];
  return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id: string): Promise<Doc | undefined> {
  return get<Doc>(id, docsStore);
}

export async function saveDoc(doc: Doc): Promise<void> {
  doc.updatedAt = Date.now();
  await set(doc.id, doc, docsStore);
  const ids: string[] = (await get('index', metaStore)) ?? [];
  if (!ids.includes(doc.id)) await set('index', [doc.id, ...ids], metaStore);
}

export async function deleteDoc(id: string): Promise<void> {
  const doc = await getDoc(id);
  if (doc) await delMany(doc.pageIds, pagesStore);
  if (doc?.kind === 'word') await del(id, wordStore);
  await del(id, docsStore);
  const ids: string[] = (await get('index', metaStore)) ?? [];
  await set('index', ids.filter((x) => x !== id), metaStore);
}

// ── Folders ────────────────────────────────────────────────────────────────
export const FOLDER_COLORS = ['#0F766E', '#F5A524', '#2563EB', '#DC2626', '#7C3AED', '#64748B'];

export async function listFolders(): Promise<Folder[]> {
  return ((await get<Folder[]>('folders', metaStore)) ?? []).sort((a, b) => a.name.localeCompare(b.name));
}

async function writeFolders(folders: Folder[]) {
  await set('folders', folders, metaStore);
}

export async function saveFolder(f: Folder): Promise<void> {
  const all = await listFolders();
  f.updatedAt = Date.now();
  const i = all.findIndex((x) => x.id === f.id);
  if (i >= 0) all[i] = f;
  else all.push(f);
  await writeFolders(all);
}

export async function createFolder(name: string, parentId: string | null, color = FOLDER_COLORS[0]): Promise<Folder> {
  const now = Date.now();
  const f: Folder = { id: uid(), name: name.trim() || 'New folder', parentId, color, createdAt: now, updatedAt: now };
  await saveFolder(f);
  return f;
}

/** IDs of a folder and all of its descendants. */
export function descendants(folders: Folder[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

export function folderPath(folders: Folder[], id: string | null | undefined): Folder[] {
  const path: Folder[] = [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = id ? byId.get(id) : undefined;
  while (cur && path.length < 50) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** Delete a folder. 'keep' moves its contents to the parent; 'all' deletes contents too. */
export async function deleteFolder(id: string, mode: 'keep' | 'all'): Promise<void> {
  const folders = await listFolders();
  const target = folders.find((f) => f.id === id);
  if (!target) return;
  const tree = descendants(folders, id);
  const docs = await listDocs();
  if (mode === 'all') {
    for (const d of docs) if (d.folderId && tree.has(d.folderId)) await deleteDoc(d.id);
    await writeFolders(folders.filter((f) => !tree.has(f.id)));
  } else {
    for (const d of docs) if (d.folderId === id) { d.folderId = target.parentId; await saveDoc(d); }
    await writeFolders(folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId: target.parentId } : f)));
  }
}

export async function moveDocs(ids: string[], folderId: string | null): Promise<void> {
  for (const id of ids) {
    const d = await getDoc(id);
    if (d) { d.folderId = folderId; await saveDoc(d); }
  }
}

/** Move a folder under another (refuses to move into itself / its descendants). */
export async function moveFolder(id: string, parentId: string | null): Promise<boolean> {
  const folders = await listFolders();
  if (parentId && descendants(folders, id).has(parentId)) return false;
  const f = folders.find((x) => x.id === id);
  if (!f) return false;
  f.parentId = parentId;
  await saveFolder(f);
  return true;
}

// ── Word documents (rich text, stored as editor JSON) ─────────────────────
const wordStore = createStore('docscan-word', 'word');
export interface WordContent { json: unknown; html: string; text: string }
export const getWord = (id: string) => get<WordContent>(id, wordStore);
export const saveWord = (id: string, c: WordContent) => set(id, c, wordStore);

export async function getPage(id: string): Promise<Page | undefined> {
  return get<Page>(id, pagesStore);
}

export async function getPages(ids: string[]): Promise<Page[]> {
  return (await getMany<Page | undefined>(ids, pagesStore)).filter(Boolean) as Page[];
}

export async function savePage(page: Page): Promise<void> {
  await set(page.id, page, pagesStore);
}

export async function deletePage(id: string): Promise<void> {
  await del(id, pagesStore);
}

/** Refresh the doc's cached thumbnail + searchable text from its pages. */
export async function refreshDocCache(doc: Doc): Promise<Doc> {
  const pages = await getPages(doc.pageIds);
  doc.thumb = pages[0]?.thumb;
  doc.text = pages.map((p) => p.ocr?.text ?? '').join('\n\n').trim();
  await saveDoc(doc);
  return doc;
}

/** Delete every local database, cache and preference (used by "Erase all data"). */
export async function eraseEverything(): Promise<void> {
  const names = ['docscan-docs', 'docscan-pages', 'docscan-meta', 'docscan-word', 'docscan-langs', 'docscan-vault', 'keyval-store'];
  const listed = (await indexedDB.databases?.().catch(() => [])) ?? [];
  for (const n of new Set([...names, ...listed.map((d) => d.name!).filter(Boolean)])) {
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(n);
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
  }
  for (const k of (await caches?.keys?.().catch(() => [])) ?? []) await caches.delete(k);
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

export async function storageEstimate(): Promise<string> {
  const est = await navigator.storage?.estimate?.();
  if (!est?.usage) return '';
  return `${(est.usage / 1048576).toFixed(1)} MB used`;
}
