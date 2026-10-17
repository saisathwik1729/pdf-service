// End-to-end: real API + real worker + real Chromium + Redis, in one process.
// Needs a Redis on REDIS_URL (default db 15, which is FLUSHED). Skips if absent.
//   node --test test/e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfsvc-e2e-'));
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379/15';
process.env.STORAGE_DIR = path.join(tmp, 'storage');
process.env.SIGNING_KEY_DIR = path.join(tmp, 'keys');
process.env.LOG_LEVEL = 'error';
process.env.PORT = String(18000 + Math.floor(Math.random() * 1000));
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.HEAVY_ROW_THRESHOLD = '300';
process.env.CHUNK_ROWS = '200';
process.env.ZIP_PART_MAX_MB = '1'; // force multiple zip parts with a small batch

const BASE = process.env.PUBLIC_BASE_URL;
const H = { 'content-type': 'application/json', 'x-api-key': 'demo-key' };
let app;
let worker;
let skip = false;

before(async () => {
  const { default: IORedis } = await import('ioredis');
  const r = new IORedis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    await r.flushdb();
    await r.quit();
  } catch {
    skip = true;
    return;
  }
  const { buildServer } = await import('../src/api/server.js');
  const { startWorker } = await import('../src/queue/worker.js');
  worker = await startWorker();
  app = await buildServer({ logger: false });
  await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
});

after(async () => {
  if (skip) return;
  await app?.close();
  await Promise.allSettled(worker.workers.map((w) => w.close()));
  await worker.pool.close();
  setTimeout(() => process.exit(0), 200).unref(); // ioredis handles keep the loop alive
});

const { makeInvoice, makePurchaseOrder } = await import('../src/lib/samples.js');
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) });

test('single document: rendered within the request, downloadable, cached on repeat', async (t) => {
  if (skip) return t.skip('no redis');
  const doc = makeInvoice({ rows: 8, seed: 101 });
  const r = await post('/v1/documents', doc);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.status, 'done');
  assert.ok(j.elapsed_ms < 5000, `took ${j.elapsed_ms}ms`);
  assert.match(j.sha256, /^[0-9a-f]{64}$/);

  const pdf = Buffer.from(await (await fetch(j.download_url)).arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pdf.length, j.bytes);
  const text = execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString();
  assert.match(text, /TAX INVOICE/);
  assert.match(text, /Data as of/);
  assert.match(text, new RegExp(`Page 1 of ${j.pages}`));
  assert.match(text, /₹/, 'rupee sign must render (font coverage)');

  const again = await (await post('/v1/documents', doc)).json();
  assert.equal(again.cached, true);
  assert.equal(again.sha256, j.sha256, 'same data => the same signed PDF, not a re-render');
});

test('resumable download: Range requests return exactly the right bytes', async (t) => {
  if (skip) return t.skip('no redis');
  const j = await (await post('/v1/documents', makeInvoice({ rows: 3, seed: 102 }))).json();
  const full = Buffer.from(await (await fetch(j.download_url)).arrayBuffer());
  const r = await fetch(j.download_url, { headers: { range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-1999/${full.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), full.subarray(1000, 2000));
  const stale = await fetch(j.download_url, { headers: { range: 'bytes=0-9', 'if-range': '"some-old-etag"' } });
  assert.equal(stale.status, 200, 'If-Range mismatch => whole file, never a mixed file');
  await stale.arrayBuffer();
});

test('bad tokens and bad totals are refused', async (t) => {
  if (skip) return t.skip('no redis');
  const bad = makeInvoice({ rows: 3, seed: 103 });
  bad.data.totals.taxable += 10;
  assert.equal((await post('/v1/documents', bad)).status, 422);
  const j = await (await post('/v1/documents', makeInvoice({ rows: 3, seed: 104 }))).json();
  assert.equal((await fetch(j.download_url.replace(/token=.*/, 'token=nope'))).status, 401);
  const noKey = await fetch(`${BASE}/v1/documents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noKey.status, 401);
});

test('null optional fields (as Django sends them) are accepted, single and bulk', async (t) => {
  if (skip) return t.skip('no redis');
  // B2C invoice without e-invoice IRN: exactly what snapshots.py produces.
  const mk = (seed) => {
    const d = makeInvoice({ rows: 3, seed });
    d.data = { ...d.data, buyer: { ...d.data.buyer, gstin: null, phone: null }, einvoice: null, po_reference: null, notes: null };
    d.data.items = d.data.items.map((it, i) => (i === 0 ? { ...it, hsn: null, item_code: null } : it));
    return d;
  };
  const r = await post('/v1/documents', mk(110));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'done');
  const b = await post('/v1/bulk', { label: 'nulls', callback_url: null, documents: [mk(111), mk(112)] });
  assert.equal(b.status, 202);
});

test('a 1,000-line purchase order is chunked and still numbered correctly', async (t) => {
  if (skip) return t.skip('no redis');
  const j = await (await post('/v1/documents?wait=25000', makePurchaseOrder({ rows: 1000, seed: 105 }))).json();
  assert.equal(j.status, 'done');
  assert.equal(j.chunks, 5);
  const pdf = Buffer.from(await (await fetch(j.download_url)).arrayBuffer());
  const text = execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString();
  assert.match(text, new RegExp(`Page ${j.pages} of ${j.pages}`));
  assert.ok(!/Page 1 of \d+[\s\S]*Page 1 of \d+/.test(text), 'page numbers do not restart per chunk');
  assert.match(text, /PO total/);
  for (const n of [1, 250, 251, 1000]) assert.match(text, new RegExp(`\\n${n} \\S`), `row ${n} present`);
});

test('bulk: snapshot, progress, multi-part zip with manifest, retry-safe counts', async (t) => {
  if (skip) return t.skip('no redis');
  const docs = Array.from({ length: 14 }, (_, i) => (i === 5 ? makePurchaseOrder({ rows: 400, seed: 200 + i }) : makeInvoice({ rows: 6, seed: 200 + i })));
  const snapshot = '2026-10-16T09:30:00.000Z';
  const res = await post('/v1/bulk', { label: 'e2e', snapshot_at: snapshot, documents: docs });
  assert.equal(res.status, 202);
  const job = await res.json();
  let v;
  for (let i = 0; i < 120; i += 1) {
    v = await (await fetch(job.status_url)).json();
    if (['done', 'partial', 'failed'].includes(v.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(v.status, 'done');
  assert.equal(v.done, 14);
  assert.ok(v.parts.length >= 2, `expected several 1MB parts, got ${v.parts.length}`);
  assert.equal(v.parts.reduce((a, p) => a + p.files, 0), 14);

  const zip = Buffer.from(await (await fetch(v.parts[0].url)).arrayBuffer());
  const zipFile = path.join(tmp, 'p1.zip');
  fs.writeFileSync(zipFile, zip);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', zipFile, 'MANIFEST.json']).toString());
  assert.equal(manifest.snapshot_at, snapshot);
  for (const f of manifest.files) {
    assert.equal(f.snapshot_at, snapshot, 'every PDF carries the batch snapshot time');
    const pdf = execFileSync('unzip', ['-p', zipFile, f.file]);
    const { sha256, verifyRecordSignature } = await import('../src/lib/crypto.js');
    assert.equal(sha256(pdf), f.sha256);
    const { file, ...record } = f;
    assert.equal(verifyRecordSignature(record), true, 'manifest records verify offline');
  }
});

test('verify: exact copy is authentic, one changed byte is detected', async (t) => {
  if (skip) return t.skip('no redis');
  const j = await (await post('/v1/documents', makeInvoice({ rows: 5, seed: 106 }))).json();
  const pdf = Buffer.from(await (await fetch(j.download_url)).arrayBuffer());
  const check = async (body) => (await fetch(`${BASE}/v1/verify`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body })).json();
  assert.equal((await check(pdf)).result, 'authentic');
  const altered = Buffer.from(pdf);
  const at = altered.indexOf('/Producer') + 12;
  altered[at] ^= 0x01;
  const v = await check(altered);
  assert.equal(v.result, 'modified');
  assert.equal(v.expected.sha256, j.sha256);
  assert.equal((await check(Buffer.from('%PDF-1.4 not ours'))).result, 'unknown');
});

test('payload HTML is escaped: markup is printed, never interpreted', async (t) => {
  if (skip) return t.skip('no redis');
  const doc = makeInvoice({ rows: 2, seed: 107 });
  doc.data.buyer.name = '<img src="http://169.254.169.254/latest/meta-data/"><script>alert(1)</script>Evil Corp';
  const j = await (await post('/v1/documents', doc)).json();
  assert.equal(j.status, 'done');
  const pdf = Buffer.from(await (await fetch(j.download_url)).arrayBuffer());
  const text = execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString();
  assert.match(text, /<img\s+src=/, 'markup is printed as text, not interpreted');
  assert.match(text, /<script>alert\(1\)<\/script>Evil Corp/);
});

test('defence in depth: even raw HTML in the page cannot make network requests', async (t) => {
  if (skip) return t.skip('no redis');
  const http = await import('node:http');
  let hits = 0;
  const probe = http.createServer((_q, s) => (hits += 1, s.end('x')));
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${probe.address().port}/leak`;
  const pdf = await worker.pool.withPage(async (page) => {
    await page.setContent(`<html><body><img src="${url}"><link rel="stylesheet" href="${url}.css"><iframe src="${url}"></iframe>hello</body></html>`, { waitUntil: 'load' });
    return page.pdf({ format: 'A4' });
  });
  probe.close();
  assert.ok(pdf.length > 0);
  assert.equal(hits, 0, 'Chromium made a network request from a rendered page');
});
