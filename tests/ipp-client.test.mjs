// Runs the Java IPP client (android/.../IppClient.java) against fake printers.
// Requires a JDK (javac/java on PATH); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { createFakePrinter } from './fake-printer.mjs';

const hasJdk = spawnSync('javac', ['-version']).status === 0;

test('native IPP client against fake Toshiba printer', { skip: !hasJdk && 'no JDK' }, async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ipp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=printer.local'], { stdio: 'ignore' });
  const plain = createFakePrinter({});
  const secure = createFakePrinter({ tls: { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) } });
  const rawChunks = [];
  const raw = net.createServer((s) => s.on('data', (d) => rawChunks.push(d)));
  await Promise.all([plain.server, secure.server, raw].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const pdf = join(dir, 'doc.pdf');
  writeFileSync(pdf, '%PDF-1.4\n%fake test document\n%%EOF\n');
  try {
    const out = join(dir, 'classes');
    execFileSync('javac', ['-d', out, 'android/app/src/main/java/com/docscan/ocr/IppClient.java', 'tests/java/IppClientTest.java']);
    // Async so the fake printers (same event loop) can answer.
    const res = await promisify(execFile)('java', ['-cp', out, 'IppClientTest', plain.server.address().port, secure.server.address().port, raw.address().port, pdf].map(String))
      .catch((e) => { throw new Error(`${e.stdout}\n${e.stderr}`); });
    console.log(res.stdout);
    assert.match(res.stdout, /ALL JAVA IPP TESTS PASSED/);

    // What the printer received
    const job = plain.jobs[0].request;
    assert.equal(job.groups.operation['document-format'][0], 'application/pdf');
    assert.equal(job.groups.operation['requesting-user-name'][0], 'alice');
    assert.equal(job.groups.operation['job-name'][0], 'Invoice 2048');
    assert.equal(job.groups.operation['printer-uri'][0], `ipp://127.0.0.1:${plain.server.address().port}/Print`);
    assert.equal(job.groups.job.copies[0], 2);
    assert.equal(job.groups.job.sides[0], 'two-sided-long-edge');
    assert.equal(job.groups.job['print-color-mode'][0], 'color');
    assert.equal(job.groups.job.media[0], 'iso_a3_297x420mm');
    assert.equal(job.groups.job['job-account-id'][0], 'DEPT-42');
    assert.ok(plain.jobs[0].data.toString().startsWith('%PDF-1.4'));
    assert.equal(secure.jobs.length, 1, 'secure job delivered once (wrong-pin attempt rejected)');

    await new Promise((r) => setTimeout(r, 200));
    const rawText = Buffer.concat(rawChunks).toString('latin1');
    assert.match(rawText, /@PJL SET COPIES=2/);
    assert.match(rawText, /@PJL SET DUPLEX=ON/);
    assert.match(rawText, /@PJL SET PAPER=A3/);
    assert.match(rawText, /@PJL ENTER LANGUAGE=PDF\r\n%PDF-1.4/);
    assert.match(rawText, /@PJL EOJ/);
  } finally {
    plain.server.close(); secure.server.close(); raw.close();
  }
});
