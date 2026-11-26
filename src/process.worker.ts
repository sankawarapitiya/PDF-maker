import { processPage, type ProcessRequest } from './process';

self.onmessage = async (e: MessageEvent<{ id: number; req: ProcessRequest }>) => {
  const { id, req } = e.data;
  try {
    const result = await processPage(req);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
