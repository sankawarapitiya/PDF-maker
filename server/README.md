# DocScan reference upload server

A dependency-free Node.js (20+) server that implements [`docs/SERVER_API.md`](../docs/SERVER_API.md). Use it as-is for small deployments, or as the specification for your own backend.

## Quick start

```bash
# 1. Secrets (keep them out of git — use your secret manager / systemd env file)
export DOCSCAN_SIGNING_SECRET=$(node server/index.mjs new-secret)   # share with app users
export DOCSCAN_API_TOKENS=$(node server/index.mjs new-token)        # optional static token(s)

# 2. Users for username/password sign-in (password ≥ 10 chars, stored as scrypt hash)
node server/index.mjs add-user alice

# 3. Run
DOCSCAN_DATA_DIR=/var/lib/docscan node server/index.mjs
```

Next, in the app:
1. Open **Settings → Server upload** and turn on **Upload to a server**.
2. Enter `https://your-host/api` and tap **Test connection**.
3. Sign in, or paste an access token.
4. Under **Security & advanced**, enter the signing secret.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listen address |
| `DOCSCAN_BASE_PATH` | `/api` | URL prefix |
| `DOCSCAN_DATA_DIR` | `./server-data` | Where documents, users and sessions are stored (mode 0700) |
| `DOCSCAN_API_TOKENS` | — | Comma-separated static bearer tokens |
| `DOCSCAN_USERS_FILE` | `<data>/users.json` | Users for password sign-in |
| `DOCSCAN_SIGNING_SECRET` | — | When set, **all** login/upload requests must carry a valid HMAC signature |
| `DOCSCAN_ALLOWED_ORIGINS` | `https://localhost,capacitor://localhost,…` | CORS allow-list. Add your PWA's origin |
| `DOCSCAN_DOC_ID_PATTERN` | `^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$` | Accepted doc-IDs. It's advertised to the app, which validates IDs before uploading |
| `DOCSCAN_MAX_UPLOAD_MB` | `50` | Request size limit |
| `DOCSCAN_SESSION_HOURS` | `12` | Login session lifetime |
| `DOCSCAN_TLS_CERT`, `DOCSCAN_TLS_KEY` | — | Serve HTTPS directly (TLS 1.2+). Otherwise run behind a TLS reverse proxy |
| `DOCSCAN_SERVER_NAME` | `DocScan Server` | Name shown in the app |

## Storage layout

```
<data>/documents/<docId>/<uploadId>.pdf    the searchable PDF
<data>/documents/<docId>/<uploadId>.json   metadata (name, pages, sha256, user, ip, time)
<data>/documents/<docId>/<uploadId>.txt    OCR text (if sent)
<data>/users.json                          scrypt password hashes
<data>/sessions.json                       SHA-256 hashes of session tokens (never raw tokens)
```

## Security measures

- **Authentication:** bearer tokens. Static tokens are compared in constant time. Login sessions are random 256-bit tokens, and only their SHA-256 hash is stored.
- **Passwords:** hashed with scrypt (N=16384). Login runs at the same speed whether or not the user exists, and is rate-limited to 8 attempts per minute per IP.
- **Signed requests:** HMAC-SHA256 over method, path, timestamp, nonce and body hash, with a ±5-minute clock window and a nonce replay cache.
- **Integrity:** the body SHA-256 is checked against the `X-Content-SHA256` header, and the stored PDF's SHA-256 is returned in the receipt.
- **Duplicates:** an `Idempotency-Key` makes retries safe.
- **Input validation:** doc-IDs are validated against a strict pattern, and the resolved path is checked to stay inside the data directory (no path traversal). Only PDFs are accepted (magic-byte check), and requests over the size limit are rejected.
- **Rate limits:** per-IP and per-user.
- **Response headers:** `no-store`, `nosniff`, `Referrer-Policy: no-referrer`, a restrictive CSP, and HSTS when TLS is enabled.
- **CORS:** an allow-list. Credentials are never accepted via cookies.
- **Files:** stored with mode 0600, directories with 0700.

## Tests

```bash
node --test server/server.test.mjs
```

The tests cover:
- authentication;
- bad, stale and replayed signatures;
- tampered bodies;
- doc-ID and path-traversal attempts;
- rejection of non-PDF files;
- idempotency;
- login and logout;
- CORS.
