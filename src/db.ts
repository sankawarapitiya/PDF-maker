import { createStore, get, set, del, getMany, delMany } from 'idb-keyval';
import type { Doc, Page, Settings } from './types';

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
  await del(id, docsStore);
  const ids: string[] = (await get('index', metaStore)) ?? [];
  await set('index', ids.filter((x) => x !== id), metaStore);
}

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
  const names = ['docscan-docs', 'docscan-pages', 'docscan-meta', 'docscan-langs', 'docscan-vault', 'keyval-store'];
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
