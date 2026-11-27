/**
 * Client for the DocScan upload API (docs/SERVER_API.md).
 * - HTTPS required (plain HTTP allowed only for localhost during development)
 * - Bearer token auth (static access token or password-login session)
 * - Optional HMAC-SHA256 request signing with timestamp + nonce (anti-replay)
 * - SHA-256 body checksum and Idempotency-Key on every upload
 */
import { getSettings } from './db';
import { getSecret, setSecret } from './vault';
import type { ServerSettings } from './types';

export const SECRET_TOKEN = 'server.accessToken';
export const SECRET_SIGNING = 'server.signingSecret';
export const SECRET_SESSION = 'server.session'; // JSON { token, expiresAt, user }
const CLIENT = 'DocScan/1.2';

export class UploadError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'rejected' | 'server' | 'config',
    readonly status = 0,
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === 'network' || this.kind === 'server';
  }
}

export interface HealthInfo {
  ok: boolean;
  name: string;
  auth: string[];
  signing: 'required' | 'off' | string;
  docIdPattern?: string;
  maxUploadMb?: number;
  time?: number;
}

export interface Session {
  token: string;
  expiresAt: number;
  user: { username: string; name?: string };
}

export interface Receipt {
  uploadId: string;
  docId: string;
  sha256: string;
  bytes: number;
  receivedAt: number;
}

const isLocalHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/** Validate & normalise the server URL; returns an error message or the URL. */
export function checkServerUrl(raw: string): { url?: string; error?: string } {
  let u: URL;
  try {
    u = new URL(raw.trim().includes('://') ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return { error: 'Enter a valid server address, e.g. https://docs.example.com/api' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname)))
    return { error: 'For security the server must use HTTPS' };
  if (u.username || u.password) return { error: 'Do not put credentials in the URL' };
  u.hash = '';
  u.search = '';
  return { url: u.href.replace(/\/+$/, '') };
}

export const docIdError = (id: string, pattern: string): string | null => {
  if (!id.trim()) return 'Enter a doc-ID';
  try {
    if (!new RegExp(pattern).test(id.trim())) return 'Doc-ID format is not valid for this server';
  } catch {
    return 'The doc-ID pattern in settings is invalid';
  }
  return null;
};

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function signHeaders(method: string, url: string, body: ArrayBuffer): Promise<Record<string, string>> {
  const bodySha = hex(await crypto.subtle.digest('SHA-256', body));
  const headers: Record<string, string> = { 'X-Content-SHA256': bodySha, 'X-DocScan-Client': CLIENT };
  const secret = await getSecret(SECRET_SIGNING);
  if (!secret) return headers;
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const canonical = `${method}\n${new URL(url).pathname}\n${ts}\n${nonce}\n${bodySha}`;
  const sig = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
  return { ...headers, 'X-DocScan-Timestamp': ts, 'X-DocScan-Nonce': nonce, 'X-DocScan-Signature': sig };
}

async function serverSettings(): Promise<ServerSettings & { base: string }> {
  const s = (await getSettings()).server;
  const { url, error } = checkServerUrl(s.url);
  if (!url) throw new UploadError(error ?? 'Server not configured', 'config');
  return { ...s, base: url };
}

function errorFrom(status: number, body: { message?: string; error?: string } | null): UploadError {
  const msg = body?.message || `Server error (${status})`;
  if (status === 401 || status === 403) return new UploadError(msg, 'auth', status);
  if (status === 408 || status === 429 || status >= 500) return new UploadError(msg, 'server', status);
  return new UploadError(msg, 'rejected', status);
}

async function request<T>(method: string, url: string, opts: { body?: ArrayBuffer; json?: unknown; token?: string; timeout?: number } = {}): Promise<T> {
  const body = opts.json !== undefined ? (new TextEncoder().encode(JSON.stringify(opts.json)).buffer as ArrayBuffer) : opts.body;
  const headers: Record<string, string> = body ? await signHeaders(method, url, body) : { 'X-DocScan-Client': CLIENT };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout ?? 15000);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  } catch {
    throw new UploadError('Cannot reach the server. Check the address and your connection.', 'network');
  } finally {
    clearTimeout(t);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw errorFrom(res.status, data);
  return data as T;
}

export async function health(rawUrl?: string): Promise<HealthInfo> {
  const base = rawUrl ? checkServerUrl(rawUrl) : { url: (await serverSettings()).base };
  if (!base.url) throw new UploadError(base.error!, 'config');
  return request<HealthInfo>('GET', `${base.url}/v1/health`, { timeout: 10000 });
}

export async function login(username: string, password: string): Promise<Session> {
  const { base } = await serverSettings();
  const s = await request<Session>('POST', `${base}/v1/auth/login`, {
    json: { username, password, device: navigator.userAgent.slice(0, 80) },
  });
  // Only the session token is stored (encrypted); the password is never kept.
  await setSecret(SECRET_SESSION, JSON.stringify(s));
  return s;
}

export async function getSession(): Promise<Session | null> {
  const raw = await getSecret(SECRET_SESSION);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  const s = await getSession();
  if (s) {
    try {
      const { base } = await serverSettings();
      await request('POST', `${base}/v1/auth/logout`, { token: s.token, timeout: 5000 });
    } catch {
      /* revoke locally regardless */
    }
  }
  await setSecret(SECRET_SESSION, null);
}

async function accessToken(): Promise<string> {
  const s = await serverSettings();
  if (s.authMethod === 'token') {
    const t = await getSecret(SECRET_TOKEN);
    if (!t) throw new UploadError('No access token saved — add it in Settings', 'auth');
    return t;
  }
  const session = await getSession();
  if (!session) throw new UploadError('Signed out — sign in again in Settings', 'auth');
  return session.token;
}

export interface UploadRequest {
  docId: string;
  name: string;
  pages: number;
  createdAt: number;
  text?: string;
  pdf: Blob;
  idempotencyKey: string;
}

/** Build the multipart body ourselves so the exact bytes can be hashed & signed. */
async function multipart(req: UploadRequest): Promise<{ body: ArrayBuffer; type: string }> {
  const boundary = `----DocScan${crypto.randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const field = (name: string, value: string) =>
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  field('docId', req.docId);
  field('name', req.name.replace(/[\r\n"]/g, ' '));
  field('pages', String(req.pages));
  field('createdAt', String(req.createdAt));
  if (req.text) field('ocrText', req.text);
  const filename = `${req.docId}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`));
  parts.push(req.pdf);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  return { body: await new Blob(parts).arrayBuffer(), type: `multipart/form-data; boundary=${boundary}` };
}

/** Upload with progress reporting (XHR, since fetch has no upload progress). */
export async function uploadDocument(req: UploadRequest, onProgress?: (p: number) => void): Promise<Receipt> {
  const { base } = await serverSettings();
  const token = await accessToken();
  const url = `${base}/v1/documents`;
  const { body, type } = await multipart(req);
  const headers = await signHeaders('POST', url, body);
  return new Promise<Receipt>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = 180_000;
    xhr.withCredentials = false;
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', type);
    xhr.setRequestHeader('Idempotency-Key', req.idempotencyKey);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Receipt);
      else reject(errorFrom(xhr.status, data as { message?: string }));
    };
    xhr.onerror = () => reject(new UploadError('Cannot reach the server. The upload will retry automatically.', 'network'));
    xhr.ontimeout = () => reject(new UploadError('The upload timed out. It will retry automatically.', 'network'));
    xhr.send(body);
  });
}
