# DocScan Server API (v1)

The app uploads scanned documents to any server that implements this contract. A complete reference implementation lives in [`server/`](../server/README.md).

The **base URL** is whatever the user enters in *Settings → Server upload*, for example `https://docs.example.com/api`. Every path below is relative to it.

## Transport

- The app requires **HTTPS**. Plain `http://` is accepted only for `localhost` during development. The Android build also refuses all cleartext traffic and ignores user-installed CAs.
- Requests are sent without cookies (`credentials: omit`), and redirects are refused.
- Browser and WebView origins are `https://localhost` (Android app), `capacitor://localhost` (iOS app), or wherever the PWA is hosted. The server must answer CORS pre-flight requests for these origins with the following headers allowed:
  - `Authorization`
  - `Content-Type`
  - `Idempotency-Key`
  - `X-Content-SHA256`
  - `X-DocScan-Timestamp`
  - `X-DocScan-Nonce`
  - `X-DocScan-Signature`
  - `X-DocScan-Client`

## Authentication

Every request except `health` and `login` carries `Authorization: Bearer <token>`. The token is either:

- an **access token** that an administrator issues and the user pastes into the app, or
- a **session token** returned by `POST /v1/auth/login`. The app stores only this token, never the password.

The app encrypts tokens at rest with AES-256-GCM, using a non-exportable device key.

## Request signing (optional, recommended)

If the user enters a *request signing secret*, every request with a body also includes these headers:

| Header | Value |
| --- | --- |
| `X-Content-SHA256` | hex SHA-256 of the exact request body (always sent) |
| `X-DocScan-Timestamp` | Unix time in milliseconds |
| `X-DocScan-Nonce` | random UUID, unique per request |
| `X-DocScan-Signature` | hex `HMAC-SHA256(secret, canonical)` |

The canonical string has five fields joined by `\n`:

```
canonical = METHOD + "\n" + URL_PATHNAME + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + BODY_SHA256
```

`URL_PATHNAME` is the full path the client requested, including the base path. For example: `/api/v1/documents`.

The server must check all of the following:
- the body hash matches the received body;
- the timestamp is within ±5 minutes;
- the nonce has not been seen within that window (this blocks replays);
- the signature matches, compared in constant time.

When a server is configured to require signing, it rejects unsigned requests.

## Endpoints

### `GET /v1/health`

This endpoint is public. The app calls it from **Test connection** and adopts `docIdPattern` automatically.

```json
{ "ok": true, "name": "Acme Records", "version": 1, "auth": ["token", "password"],
  "signing": "required", "docIdPattern": "^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$", "maxUploadMb": 50 }
```

### `POST /v1/auth/login`

Request body (JSON): `{ "username": "...", "password": "...", "device": "user agent" }`

Response `200`: `{ "token": "...", "expiresAt": 1767225600000, "user": { "username": "alice", "name": "Alice" } }`

### `POST /v1/auth/logout`

Revokes the bearer session token. Returns `200 {"ok": true}`.

### `POST /v1/documents`

The body is `multipart/form-data` with these parts:

| Part | Content |
| --- | --- |
| `docId` | the doc-ID the user entered or scanned |
| `name` | the document title in the app |
| `pages` | page count |
| `createdAt` | creation time in ms |
| `ocrText` | *(optional)* the recognised text, with each page prefixed `--- Page n ---` |
| `file` | the searchable PDF (`application/pdf`, filename `<docId>.pdf`) |

The request also sends an `Idempotency-Key` header. Retries of the same upload reuse that key, and the server must return the original receipt instead of storing the document again.

Response `201` (or `200` for an idempotent repeat):

```json
{ "uploadId": "mwx1f2-9a8b7c6d5e4f", "docId": "INV-2048", "sha256": "<hex of the PDF>", "bytes": 182733, "receivedAt": 1767225600000 }
```

### `GET /v1/documents/{docId}`

Lists the uploads for a doc-ID: `{ "docId": "...", "uploads": [ {uploadId, name, pages, bytes, sha256, receivedAt, user}, … ] }`

## Errors

Errors are returned as JSON: `{ "error": "code", "message": "Human readable" }`. The app reacts based on the HTTP status:

| Status | App behaviour |
| --- | --- |
| `401` / `403` | The upload is marked **failed** and the user is asked to sign in or fix credentials. |
| `400` / `413` / `415` / `422` | The upload is marked **failed** and the message is shown (for example, an invalid doc-ID). |
| `408` / `429` / `5xx` / network error | The upload stays **queued**. The app retries automatically with back-off from 15 s up to 30 min, and also when the device comes back online, when the app is unlocked, or when the user taps *Retry now*. |
