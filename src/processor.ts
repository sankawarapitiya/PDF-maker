import { processPage, type ProcessRequest, type ProcessResult } from './process';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { res: (r: ProcessResult) => void; rej: (e: Error) => void }>();
const workerCapable = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

function getWorker(): Worker | null {
  if (!workerCapable) return null;
  if (!worker) {
    worker = new Worker(new URL('./process.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.rej(new Error(error));
      else p.res(result);
    };
  }
  return worker;
}

/** Runs page processing off the main thread when possible. */
export function process(req: ProcessRequest): Promise<ProcessResult> {
  const w = getWorker();
  if (!w) return processPage(req);
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    w.postMessage({ id, req });
  });
}
