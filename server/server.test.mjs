import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, loadConfig, hashPassword, canonical } from './index.mjs';

const SECRET = 'test-signing-secret-0123456789';
const TOKEN = 'static-token-abcdefghijklmnop';
let base, server, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docscan-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify({ alice: { password: hashPassword('correct horse battery') } }));
  server = createServer(loadConfig({ dataDir, apiTokens: TOKEN, signingSecret: SECRET, log: false, port: 0 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const pdf = Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

function multipart(fields, file) {
  const b = `----docscan${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), file, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

function signed(method, url, body, { secret = SECRET, ts = Date.now(), nonce = crypto.randomUUID() } = {}) {
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const sig = crypto.createHmac('sha256', secret).update(canonical(method, new URL(url).pathname, ts, nonce, sha)).digest('hex');
  return { 'X-DocScan-Timestamp': String(ts), 'X-DocScan-Nonce': nonce, 'X-DocScan-Signature': sig, 'X-Content-SHA256': sha };
}

async function upload({ docId = 'INV-2048', token = TOKEN, sign = {}, file = pdf, headers = {} } = {}) {
  const { body, type } = multipart({ docId, name: 'Invoice', pages: '1', ocrText: 'hello world' }, file);
  const url = `${base}/v1/documents`;
  return fetch(url, {
    method: 'POST', body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, ...(sign === null ? {} : signed('POST', url, body, sign)), ...headers },
  });
}

test('health is public and describes the server', async () => {
  const r = await (await fetch(`${base}/v1/health`)).json();
  assert.equal(r.ok, true);
  assert.equal(r.signing, 'required');
  assert.deepEqual(r.auth.sort(), ['password', 'token']);
});

test('signed upload with static token is stored', async () => {
  const r = await upload();
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.docId, 'INV-2048');
  const dir = path.join(dataDir, 'documents', 'INV-2048');
  assert.ok(fs.existsSync(path.join(dir, `${j.uploadId}.pdf`)));
  assert.equal(fs.readFileSync(path.join(dir, `${j.uploadId}.txt`), 'utf8'), 'hello world');
  const list = await (await fetch(`${base}/v1/documents/INV-2048`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(list.uploads.length, 1);
  assert.equal(list.uploads[0].ip, undefined, 'IP is not exposed');
});

test('rejects missing / wrong token', async () => {
  assert.equal((await upload({ token: 'nope' })).status, 401);
});

test('rejects unsigned, wrongly signed, stale and replayed requests', async () => {
  assert.equal((await upload({ sign: null })).status, 401);
  assert.equal((await upload({ sign: { secret: 'wrong' } })).status, 401);
  assert.equal((await upload({ sign: { ts: Date.now() - 10 * 60_000 } })).status, 401);
  const nonce = crypto.randomUUID();
  assert.equal((await upload({ sign: { nonce } })).status, 201);
  const replay = await upload({ sign: { nonce } });
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, 'replayed');
});

test('rejects tampered body (checksum mismatch)', async () => {
  const r = await upload({ headers: { 'X-Content-SHA256': 'a'.repeat(64) } });
  assert.equal(r.status, 400);
});

test('validates doc-ID and blocks path traversal', async () => {
  for (const docId of ['../../etc', 'a', 'bad id!', '..', 'x'.repeat(100)]) {
    assert.equal((await upload({ docId })).status, 422, docId);
  }
});

test('only PDFs are accepted', async () => {
  assert.equal((await upload({ file: Buffer.from('<html>evil</html>') })).status, 415);
});

test('idempotency key returns the original receipt', async () => {
  const key = crypto.randomUUID();
  const a = await (await upload({ headers: { 'Idempotency-Key': key } })).json();
  const b = await upload({ headers: { 'Idempotency-Key': key } });
  assert.equal(b.status, 200);
  assert.equal((await b.json()).uploadId, a.uploadId);
});

test('password login issues a session token; logout revokes it', async () => {
  const login = async (password) => {
    const body = Buffer.from(JSON.stringify({ username: 'alice', password }));
    const url = `${base}/v1/auth/login`;
    return fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signed('POST', url, body) } });
  };
  assert.equal((await login('wrong password')).status, 401);
  const ok = await login('correct horse battery');
  assert.equal(ok.status, 200);
  const { token, expiresAt } = await ok.json();
  assert.ok(expiresAt > Date.now());
  assert.equal((await upload({ token })).status, 201);
  const out = await fetch(`${base}/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(out.status, 200);
  assert.equal((await upload({ token })).status, 401);
  const stored = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(token), 'raw tokens are never written to disk');
});

test('CORS only for allowed origins', async () => {
  const ok = await fetch(`${base}/v1/health`, { method: 'OPTIONS', headers: { Origin: 'https://localhost' } });
  assert.equal(ok.status, 204);
  const bad = await fetch(`${base}/v1/health`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
});
