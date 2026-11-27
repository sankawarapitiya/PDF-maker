// Fake IPP printer (Toshiba e-STUDIO-like) for testing the native IPP client.
// Supports Get-Printer-Attributes, Print-Job (stores documents) and Get-Job-Attributes.
import http from 'node:http';
import https from 'node:https';

export function decodeIpp(buf) {
  let o = 0;
  const u8 = () => buf[o++];
  const u16 = () => { const v = buf.readUInt16BE(o); o += 2; return v; };
  const version = u16(); const op = u16(); const requestId = buf.readInt32BE(o); o += 4;
  const groups = {}; let group = null; let last = null;
  while (o < buf.length) {
    const tag = u8();
    if (tag === 0x03) break;
    if (tag <= 0x0f) { group = { 1: 'operation', 2: 'job', 4: 'printer' }[tag] ?? String(tag); groups[group] ??= {}; continue; }
    const nl = u16(); const name = nl ? buf.toString('utf8', o, o + nl) : null; o += nl;
    const vl = u16(); const raw = buf.subarray(o, o + vl); o += vl;
    if (name) last = name;
    const val = tag === 0x21 || tag === 0x23 ? raw.readInt32BE(0) : tag === 0x22 ? raw[0] === 1 : raw.toString('utf8');
    (groups[group][last] ??= []).push(val);
  }
  return { version, op, requestId, groups, data: buf.subarray(o) };
}

function encode(status, requestId, groups) {
  const parts = [];
  const h = Buffer.alloc(8); h.writeUInt16BE(0x0200, 0); h.writeUInt16BE(status, 2); h.writeInt32BE(requestId, 4); parts.push(h);
  const attr = (tag, name, value) => {
    const n = Buffer.from(name);
    let v;
    if (typeof value === 'number') { v = Buffer.alloc(4); v.writeInt32BE(value); }
    else if (typeof value === 'boolean') v = Buffer.from([value ? 1 : 0]);
    else v = Buffer.from(value);
    const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
    let o = 0; b[o++] = tag; b.writeUInt16BE(n.length, o); o += 2; n.copy(b, o); o += n.length; b.writeUInt16BE(v.length, o); o += 2; v.copy(b, o);
    parts.push(b);
  };
  for (const [gtag, attrs] of groups) {
    parts.push(Buffer.from([gtag]));
    for (const [tag, name, values] of attrs) values.forEach((v, i) => attr(tag, i ? '' : name, v));
  }
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}

export function createFakePrinter({ tls, path = '/Print', formats = ['application/pdf', 'image/jpeg', 'application/octet-stream'] } = {}) {
  const jobs = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== path || req.headers['content-type'] !== 'application/ipp') { res.writeHead(404); return res.end(); }
      const r = decodeIpp(Buffer.concat(chunks));
      const C = 0x47, L = 0x48;
      const opAttrs = [[C, 'attributes-charset', ['utf-8']], [L, 'attributes-natural-language', ['en']]];
      let body;
      if (r.op === 0x000b) {
        body = encode(0, r.requestId, [[1, opAttrs], [4, [
          [0x41, 'printer-make-and-model', ['TOSHIBA e-STUDIO3015AC']],
          [0x42, 'printer-name', ['Floor2-Copier']],
          [0x23, 'printer-state', [3]],
          [0x44, 'printer-state-reasons', ['none']],
          [0x49, 'document-format-supported', formats],
          [0x22, 'color-supported', [true]],
          [0x44, 'sides-supported', ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']],
          [0x44, 'media-supported', ['iso_a4_210x297mm', 'iso_a3_297x420mm']],
        ]]]);
      } else if (r.op === 0x0002) {
        const fmt = r.groups.operation['document-format']?.[0];
        if (!formats.includes(fmt)) body = encode(0x040a, r.requestId, [[1, opAttrs]]);
        else {
          const id = jobs.length + 101;
          jobs.push({ id, request: r, data: r.data });
          body = encode(0, r.requestId, [[1, opAttrs], [2, [[0x21, 'job-id', [id]], [0x23, 'job-state', [3]]]]]);
        }
      } else if (r.op === 0x0009) {
        const id = r.groups.operation['job-id']?.[0];
        body = jobs.some((j) => j.id === id)
          ? encode(0, r.requestId, [[1, opAttrs], [2, [[0x23, 'job-state', [9]], [0x44, 'job-state-reasons', ['job-completed-successfully']]]]])
          : encode(0x0406, r.requestId, [[1, opAttrs]]);
      } else body = encode(0x0501, r.requestId, [[1, opAttrs]]);
      // Chunked response like many real printers
      res.writeHead(200, { 'Content-Type': 'application/ipp' });
      res.end(body);
    });
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  return { server, jobs };
}
