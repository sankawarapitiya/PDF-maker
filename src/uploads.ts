/**
 * Upload queue: one upload at a time, automatic retry with exponential
 * back-off for network/server errors, resume when the device comes back
 * online or the app is unlocked. Retries reuse the same Idempotency-Key so
 * the server never stores a document twice.
 */
import { deleteDoc, getDoc, getPages, getSettings, listDocs, saveDoc } from './db';
import { buildPdf } from './pdf';
import { UploadError, docIdError, uploadDocument } from './server';
import type { Doc, UploadState } from './types';

export const uploadEvents = new EventTarget();
export interface UploadEvent {
  docId: string;
  state?: UploadState;
  progress?: number;
  deleted?: boolean;
}
const emit = (d: UploadEvent) => uploadEvents.dispatchEvent(new CustomEvent<UploadEvent>('upload', { detail: d }));

let chain: Promise<unknown> = Promise.resolve();
let retryTimer = 0;
const running = new Set<string>();

const backoff = (attempts: number) => Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));

/** Queue a document for upload under the given server doc-ID. */
export async function queueUpload(doc: Doc, remoteDocId: string, includeText: boolean): Promise<void> {
  const s = (await getSettings()).server;
  const err = docIdError(remoteDocId, s.docIdPattern);
  if (err) throw new UploadError(err, 'config');
  const fresh = (await getDoc(doc.id)) ?? doc;
  fresh.remoteDocId = remoteDocId.trim();
  fresh.upload = {
    status: 'queued',
    remoteDocId: remoteDocId.trim(),
    includeText,
    attemptId: crypto.randomUUID(),
    attempts: 0,
    updatedAt: Date.now(),
  };
  await saveDoc(fresh);
  emit({ docId: fresh.id, state: fresh.upload });
  await enqueue(fresh.id);
}

function enqueue(docId: string): Promise<void> {
  const job = chain.then(() => run(docId));
  chain = job.catch(() => undefined);
  return job;
}

async function update(doc: Doc, patch: Partial<UploadState>) {
  doc.upload = { ...doc.upload!, ...patch, updatedAt: Date.now() };
  await saveDoc(doc);
  emit({ docId: doc.id, state: doc.upload });
}

async function run(docId: string): Promise<void> {
  const doc = await getDoc(docId);
  if (!doc?.upload || doc.upload.status === 'uploaded' || running.has(docId)) return;
  running.add(docId);
  try {
    const settings = await getSettings();
    if (!settings.server.enabled) throw new UploadError('Server upload is turned off in Settings', 'config');
    await update(doc, { status: 'uploading', attempts: doc.upload.attempts + 1, error: undefined });
    const pages = await getPages(doc.pageIds);
    if (!pages.length) throw new UploadError('Document has no pages', 'rejected');
    const pdf = await buildPdf(pages, { size: settings.pageSize, title: doc.name });
    const text = doc.upload.includeText
      ? pages.map((p, i) => `--- Page ${i + 1} ---\n${p.ocr?.text ?? ''}`).join('\n\n')
      : undefined;
    const receipt = await uploadDocument(
      {
        docId: doc.upload.remoteDocId,
        name: doc.name,
        pages: pages.length,
        createdAt: doc.createdAt,
        text,
        pdf,
        idempotencyKey: doc.upload.attemptId,
      },
      (p) => emit({ docId, state: doc.upload, progress: p }),
    );
    const r = { uploadId: receipt.uploadId, sha256: receipt.sha256, bytes: receipt.bytes, receivedAt: receipt.receivedAt };
    doc.uploadHistory = [{ ...r, remoteDocId: doc.upload.remoteDocId }, ...(doc.uploadHistory ?? [])].slice(0, 20);
    await update(doc, { status: 'uploaded', receipt: r, nextRetryAt: undefined });
    if (settings.server.deleteAfterUpload) {
      await deleteDoc(doc.id);
      emit({ docId, deleted: true });
    }
  } catch (e) {
    const err = e instanceof UploadError ? e : new UploadError(String((e as Error)?.message ?? e), 'rejected');
    const fresh = (await getDoc(docId)) ?? doc;
    if (!fresh.upload) return;
    if (err.retryable) {
      await update(fresh, { status: 'queued', error: err.message, nextRetryAt: Date.now() + backoff(fresh.upload.attempts) });
      scheduleRetry();
    } else {
      await update(fresh, { status: 'failed', error: err.message, nextRetryAt: undefined });
    }
    throw err;
  } finally {
    running.delete(docId);
  }
}

/** Run queued uploads whose retry time has come; schedule the next one. */
export async function resumeQueue(force = false): Promise<void> {
  clearTimeout(retryTimer);
  if (!(await getSettings()).server.enabled) return;
  const docs = await listDocs();
  for (const d of docs) {
    const u = d.upload;
    if (!u) continue;
    const due = u.status === 'uploading' || (u.status === 'queued' && (force || !u.nextRetryAt || u.nextRetryAt <= Date.now()));
    if (due) enqueue(d.id).catch(() => undefined);
  }
  scheduleRetry();
}

async function scheduleRetry() {
  clearTimeout(retryTimer);
  const docs = await listDocs();
  const next = docs
    .map((d) => d.upload)
    .filter((u): u is UploadState => u?.status === 'queued' && !!u.nextRetryAt)
    .reduce((m, u) => Math.min(m, u.nextRetryAt!), Infinity);
  if (next < Infinity) retryTimer = window.setTimeout(() => resumeQueue(), Math.max(1000, next - Date.now()));
}

export async function pendingCount(): Promise<number> {
  return (await listDocs()).filter((d) => d.upload && d.upload.status !== 'uploaded').length;
}

export function initUploads(): void {
  window.addEventListener('online', () => resumeQueue(true));
  resumeQueue();
}

export function describe(u: UploadState | undefined): { label: string; tone: 'ok' | 'busy' | 'warn' | 'err' } | null {
  if (!u) return null;
  switch (u.status) {
    case 'uploaded':
      return { label: `Uploaded · ${u.remoteDocId}`, tone: 'ok' };
    case 'uploading':
      return { label: `Uploading · ${u.remoteDocId}`, tone: 'busy' };
    case 'queued':
      return { label: u.error ? `Waiting to retry · ${u.remoteDocId}` : `Queued · ${u.remoteDocId}`, tone: 'warn' };
    default:
      return { label: `Upload failed · ${u.remoteDocId}`, tone: 'err' };
  }
}
