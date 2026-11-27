#!/usr/bin/env node
/**
 * DocScan reference upload server — zero dependencies, Node.js 20+.
 *
 * Implements the API in docs/SERVER_API.md:
 *   GET  /v1/health
 *   POST /v1/auth/login        { username, password }  -> { token, expiresAt, user }
 *   POST /v1/auth/logout
 *   POST /v1/documents         multipart: docId, name, pages, createdAt, ocrText?, file(PDF)
 *   GET  /v1/documents/:docId  list uploads for a doc-ID
 *
 * Security: bearer tokens (static API tokens and/or user sessions), scrypt
 * password hashes, HMAC-SHA256 request signatures with timestamp + nonce
 * replay protection, body SHA-256 integrity check, idempotency keys, rate
 * limiting, CORS allow-list, size limits, strict doc-ID validation, optional
 * native TLS.
 *
 * Usage:
 *   node server/index.mjs                     start (config from env, see below)
 *   node server/index.mjs add-user <name>     create/replace a user (prompts for password)
 *   node server/index.mjs new-token           print a random API token
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// ── Configuration ───────────────────────────────────────────────────────────
const env = process.env;
export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? env.DOCSCAN_DATA_DIR ?? 'server-data');
  return {
    port: Number(overrides.port ?? env.PORT ?? 8787),
    host: overrides.host ?? env.HOST ?? '0.0.0.0',
    basePath: (overrides.basePath ?? env.DOCSCAN_BASE_PATH ?? '/api').replace(/\/$/, ''),
    dataDir,
    usersFile: overrides.usersFile ?? env.DOCSCAN_USERS_FILE ?? path.join(dataDir, 'users.json'),
    // Static API tokens (comma separated). Store only in env / secrets manager.
    apiTokens: (overrides.apiTokens ?? env.DOCSCAN_API_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    // Shared HMAC secret. When set, every document/auth request must be signed.
    signingSecret: overrides.signingSecret ?? env.DOCSCAN_SIGNING_SECRET ?? '',
    allowedOrigins: (overrides.allowedOrigins ?? env.DOCSCAN_ALLOWED_ORIGINS ??
      'https://localhost,capacitor://localhost,http://localhost:5173,http://localhost:4173')
      .split(',').map((s) => s.trim()).filter(Boolean),
    maxUploadBytes: Number(overrides.maxUploadMb ?? env.DOCSCAN_MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
    docIdPattern: new RegExp(overrides.docIdPattern ?? env.DOCSCAN_DOC_ID_PATTERN ?? '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'),
    sessionHours: Number(overrides.sessionHours ?? env.DOCSCAN_SESSION_HOURS ?? 12),
    tlsCert: overrides.tlsCert ?? env.DOCSCAN_TLS_CERT,
    tlsKey: overrides.tlsKey ?? env.DOCSCAN_TLS_KEY,
    clockSkewMs: 5 * 60 * 1000,
    name: overrides.name ?? env.DOCSCAN_SERVER_NAME ?? 'DocScan Server',
    log: overrides.log ?? true,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const safeEqual = (a, b) => {
  const A = Buffer.from(sha256(String(a)));
  const B = Buffer.from(sha256(String(b)));
  return crypto.timingSafeEqual(A, B);
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

/** Minimal multipart/form-data parser for an in-memory body. */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new HttpError(400, 'bad_request', 'Missing multipart boundary');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  const files = {};
  let pos = body.indexOf(boundary);
  if (pos < 0) throw new HttpError(400, 'bad_request', 'Malformed multipart body');
  while (true) {
    pos += boundary.length;
    if (body.subarray(pos, pos + 2).toString() === '--') break;
    pos += 2; // CRLF
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) throw new HttpError(400, 'bad_request', 'Malformed multipart part');
    const headers = body.subarray(pos, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) throw new HttpError(400, 'bad_request', 'Unterminated multipart body');
    const content = body.subarray(headerEnd + 4, next - 2); // strip CRLF before boundary
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    if (name) {
      if (filename !== undefined) files[name] = { filename, type, data: content };
      else fields[name] = content.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

/** Canonical string the client signs (see docs/SERVER_API.md). */
export function canonical(method, pathname, ts, nonce, bodySha) {
  return `${method.toUpperCase()}\n${pathname}\n${ts}\n${nonce}\n${bodySha}`;
}

// ── Server ──────────────────────────────────────────────────────────────────
export function createServer(config = loadConfig()) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const sessionsFile = path.join(config.dataDir, 'sessions.json');
  /** sha256(token) -> { user, exp } */
  const sessions = new Map(Object.entries(readJson(sessionsFile, {})));
  const nonces = new Map(); // nonce -> expiry
  const idempotency = new Map(); // key -> response json
  const buckets = new Map(); // rate limiting

  const log = (...a) => config.log && console.log(new Date().toISOString(), ...a);

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }
  const users = () => readJson(config.usersFile, {});
  const persistSessions = () =>
    fs.writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });

  function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    const b = buckets.get(key) ?? { count: 0, reset: now + windowMs };
    if (now > b.reset) {
      b.count = 0;
      b.reset = now + windowMs;
    }
    b.count++;
    buckets.set(key, b);
    if (b.count > limit) throw new HttpError(429, 'rate_limited', 'Too many requests, slow down');
  }

  function cleanup() {
    const now = Date.now();
    for (const [k, exp] of nonces) if (exp < now) nonces.delete(k);
    let changed = false;
    for (const [k, s] of sessions) if (s.exp < now) { sessions.delete(k); changed = true; }
    if (changed) persistSessions();
    if (idempotency.size > 5000) idempotency.clear();
    for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
  }
  const timer = setInterval(cleanup, 60_000);
  timer.unref();

  function authenticate(req) {
    const h = req.headers.authorization || '';
    const token = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim();
    if (!token) throw new HttpError(401, 'unauthorized', 'Missing access token');
    for (const t of config.apiTokens) if (safeEqual(t, token)) return { user: 'api-token', kind: 'token' };
    const s = sessions.get(sha256(token));
    if (s && s.exp > Date.now()) return { user: s.user, kind: 'session', tokenHash: sha256(token) };
    throw new HttpError(401, 'unauthorized', 'Invalid or expired access token');
  }

  function verifySignature(req, pathname, body) {
    const bodySha = sha256(body);
    const claimed = String(req.headers['x-content-sha256'] || '').toLowerCase();
    if (claimed && claimed !== bodySha) throw new HttpError(400, 'checksum_mismatch', 'Body checksum mismatch');
    if (!config.signingSecret) return;
    const ts = String(req.headers['x-docscan-timestamp'] || '');
    const nonce = String(req.headers['x-docscan-nonce'] || '');
    const sig = String(req.headers['x-docscan-signature'] || '');
    if (!ts || !nonce || !sig) throw new HttpError(401, 'signature_required', 'Request must be signed');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(nonce)) throw new HttpError(401, 'bad_signature', 'Invalid nonce');
    if (Math.abs(Date.now() - Number(ts)) > config.clockSkewMs)
      throw new HttpError(401, 'stale_request', 'Request timestamp outside allowed window — check the device clock');
    const expected = crypto.createHmac('sha256', config.signingSecret).update(canonical(req.method, pathname, ts, nonce, bodySha)).digest('hex');
    if (!safeEqual(expected, sig.toLowerCase())) throw new HttpError(401, 'bad_signature', 'Invalid request signature');
    if (nonces.has(nonce)) throw new HttpError(401, 'replayed', 'Request was already processed (replay)');
    nonces.set(nonce, Date.now() + config.clockSkewMs * 2);
  }

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'too_large', `Upload exceeds ${Math.round(limit / 1048576)} MB limit`);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  function docDir(docId) {
    if (!config.docIdPattern.test(docId)) throw new HttpError(422, 'invalid_doc_id', 'Doc-ID has an invalid format');
    const dir = path.resolve(config.dataDir, 'documents', docId);
    if (!dir.startsWith(path.resolve(config.dataDir, 'documents') + path.sep)) throw new HttpError(422, 'invalid_doc_id', 'Invalid doc-ID');
    return dir;
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  async function route(req, res, pathname, ip) {
    const p = pathname.slice(config.basePath.length) || '/';
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && p === '/v1/health') {
      return send(200, {
        ok: true,
        name: config.name,
        version: 1,
        auth: [...(config.apiTokens.length ? ['token'] : []), ...(Object.keys(users()).length ? ['password'] : [])],
        signing: config.signingSecret ? 'required' : 'off',
        docIdPattern: config.docIdPattern.source,
        maxUploadMb: Math.round(config.maxUploadBytes / 1048576),
        time: Date.now(),
      });
    }

    if (req.method === 'POST' && p === '/v1/auth/login') {
      rateLimit(`login:${ip}`, 8, 60_000);
      const body = await readBody(req, 16 * 1024);
      verifySignature(req, pathname, body);
      let creds;
      try {
        creds = JSON.parse(body.toString('utf8'));
      } catch {
        throw new HttpError(400, 'bad_request', 'Expected JSON body');
      }
      const u = users()[String(creds.username || '')];
      // Always run scrypt so timing doesn't reveal whether the user exists.
      const ok = verifyPassword(String(creds.password || ''), u?.password ?? hashPassword('x'));
      if (!u || !ok) {
        log('login failed', creds.username, ip);
        throw new HttpError(401, 'invalid_credentials', 'Wrong username or password');
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const exp = Date.now() + config.sessionHours * 3600_000;
      sessions.set(sha256(token), { user: creds.username, exp, device: String(creds.device || '').slice(0, 80) });
      persistSessions();
      log('login', creds.username, ip);
      return send(200, { token, expiresAt: exp, user: { username: creds.username, name: u.name ?? creds.username } });
    }

    if (req.method === 'POST' && p === '/v1/auth/logout') {
      const who = authenticate(req);
      if (who.tokenHash) {
        sessions.delete(who.tokenHash);
        persistSessions();
      }
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && p === '/v1/documents') {
      const who = authenticate(req);
      rateLimit(`upload:${who.user}`, 60, 60_000);
      const idemKey = String(req.headers['idempotency-key'] || '');
      if (idemKey && idempotency.has(`${who.user}:${idemKey}`)) {
        req.resume();
        return send(200, idempotency.get(`${who.user}:${idemKey}`));
      }
      const body = await readBody(req, config.maxUploadBytes);
      verifySignature(req, pathname, body);
      const { fields, files } = parseMultipart(body, req.headers['content-type']);
      const docId = String(fields.docId || '').trim();
      const dir = docDir(docId);
      const file = files.file;
      if (!file || !file.data.length) throw new HttpError(400, 'missing_file', 'No document file in upload');
      if (file.data.subarray(0, 5).toString() !== '%PDF-') throw new HttpError(415, 'unsupported_type', 'Only PDF uploads are accepted');
      const uploadId = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fileSha = sha256(file.data);
      fs.writeFileSync(path.join(dir, `${uploadId}.pdf`), file.data, { mode: 0o600 });
      const meta = {
        uploadId,
        docId,
        name: String(fields.name || 'Scan').slice(0, 200),
        pages: Number(fields.pages) || null,
        createdAt: Number(fields.createdAt) || null,
        receivedAt: Date.now(),
        bytes: file.data.length,
        sha256: fileSha,
        user: who.user,
        ip,
        hasText: !!fields.ocrText,
      };
      fs.writeFileSync(path.join(dir, `${uploadId}.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
      if (fields.ocrText) fs.writeFileSync(path.join(dir, `${uploadId}.txt`), fields.ocrText, { mode: 0o600 });
      log('upload', docId, uploadId, `${file.data.length}B`, who.user, ip);
      const out = { uploadId, docId, sha256: fileSha, bytes: file.data.length, receivedAt: meta.receivedAt };
      if (idemKey) idempotency.set(`${who.user}:${idemKey}`, out);
      return send(201, out);
    }

    const list = /^\/v1\/documents\/([^/]+)$/.exec(p);
    if (req.method === 'GET' && list) {
      authenticate(req);
      const dir = docDir(decodeURIComponent(list[1]));
      const items = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
            const { ip: _ip, ...m } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            return m;
          })
        : [];
      return send(200, { docId: decodeURIComponent(list[1]), uploads: items.sort((a, b) => b.receivedAt - a.receivedAt) });
    }

    throw new HttpError(404, 'not_found', 'Not found');
  }

  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const ip = req.socket.remoteAddress || '';
    // Security headers on every response.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (config.tlsCert) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, X-Content-SHA256, X-DocScan-Timestamp, X-DocScan-Nonce, X-DocScan-Signature, X-DocScan-Client');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(origin && config.allowedOrigins.includes(origin) ? 204 : 403);
      return res.end();
    }
    const pathname = new URL(req.url, 'http://x').pathname;
    try {
      if (!pathname.startsWith(config.basePath + '/')) throw new HttpError(404, 'not_found', 'Not found');
      rateLimit(`ip:${ip}`, 300, 60_000);
      await route(req, res, pathname, ip);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log('error', e);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.code ?? 'server_error', message: status === 500 ? 'Internal server error' : e.message }));
      }
      req.resume();
    }
  };

  const server = config.tlsCert
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey), minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler);
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  return server;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function prompt(q, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(q) ? s : '');
  const a = await new Promise((r) => rl.question(q, r));
  rl.close();
  if (hidden) process.stdout.write('\n');
  return a;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server/index.mjs');
if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  const config = loadConfig();
  if (cmd === 'add-user') {
    if (!arg) throw new Error('usage: add-user <username>');
    const pw = env.DOCSCAN_PASSWORD ?? (await prompt('Password: ', true));
    if (pw.length < 10) throw new Error('Password must be at least 10 characters');
    fs.mkdirSync(path.dirname(config.usersFile), { recursive: true, mode: 0o700 });
    let users = {};
    try { users = JSON.parse(fs.readFileSync(config.usersFile, 'utf8')); } catch { /* new file */ }
    users[arg] = { password: hashPassword(pw), name: arg, createdAt: Date.now() };
    fs.writeFileSync(config.usersFile, JSON.stringify(users, null, 2), { mode: 0o600 });
    console.log(`User "${arg}" saved to ${config.usersFile}`);
  } else if (cmd === 'new-token' || cmd === 'new-secret') {
    console.log(crypto.randomBytes(32).toString('base64url'));
  } else {
    if (!config.apiTokens.length && !Object.keys((() => { try { return JSON.parse(fs.readFileSync(config.usersFile, 'utf8')); } catch { return {}; } })()).length)
      console.warn('WARNING: no API tokens or users configured — every request will be rejected. See server/README.md');
    if (!config.signingSecret) console.warn('NOTE: DOCSCAN_SIGNING_SECRET not set — request signing is disabled.');
    if (!config.tlsCert) console.warn('NOTE: serving plain HTTP. Put this behind an HTTPS reverse proxy (required by the app).');
    createServer(config).listen(config.port, config.host, () =>
      console.log(`${config.name} listening on ${config.tlsCert ? 'https' : 'http'}://${config.host}:${config.port}${config.basePath}`));
  }
}
