// Pure-logic tests: no Redis, no Chromium.   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SIGNING_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfsvc-keys-'));
process.env.DOWNLOAD_TOKEN_SECRET = 'unit-test-secret';

const { amountInWordsINR, integerToIndianWords } = await import('../src/lib/numwords.js');
const { canonicalJson, documentKey, signRecord, verifyRecordSignature, makeToken, readToken } = await import('../src/lib/crypto.js');
const { reconcile } = await import('../src/lib/validate.js');
const { planChunks } = await import('../src/render/renderer.js');
const { parseRange } = await import('../src/api/files.js');
const { makeInvoice, makePurchaseOrder } = await import('../src/lib/samples.js');
const { Semaphore } = await import('../src/lib/semaphore.js');

test('amount in words uses lakh/crore', () => {
  assert.equal(integerToIndianWords(120000), 'One Lakh Twenty Thousand');
  assert.equal(integerToIndianWords(27053544), 'Two Crore Seventy Lakh Fifty Three Thousand Five Hundred Forty Four');
  assert.equal(amountInWordsINR(1001.5), 'Rupees One Thousand One and Fifty Paise Only');
  assert.equal(amountInWordsINR(0), 'Rupees Zero Only');
});

test('canonical JSON ignores key order, so identical data => identical document key', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } }), canonicalJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }));
  const doc = makeInvoice({ rows: 4, seed: 9 });
  const shuffled = JSON.parse(JSON.stringify({ data: doc.data, type: doc.type }));
  assert.equal(documentKey('t1', doc), documentKey('t1', shuffled));
  assert.notEqual(documentKey('t1', doc), documentKey('t2', doc), 'tenants never share a key');
  const edited = structuredClone(doc);
  edited.data.items[0].qty += 1;
  assert.notEqual(documentKey('t1', doc), documentKey('t1', edited), 'any data change => new key => new render');
});

test('signed records verify, and any field change breaks the signature', () => {
  const rec = signRecord({ v: 1, doc_key: 'abc', sha256: 'f'.repeat(64), bytes: 10, generated_at: '2026-10-16T00:00:00Z' });
  assert.ok(rec.signature && rec.key_id);
  assert.equal(verifyRecordSignature(rec), true);
  assert.equal(verifyRecordSignature({ ...rec, sha256: 'e'.repeat(64) }), false);
  assert.equal(verifyRecordSignature({ ...rec, bytes: 11 }), false);
  assert.equal(verifyRecordSignature({ ...rec, signature: undefined }), false);
});

test('download tokens: valid, forged and expired', () => {
  const t = makeToken({ d: 'k1', t: 'acme' });
  assert.deepEqual({ d: readToken(t).d, t: readToken(t).t }, { d: 'k1', t: 'acme' });
  const [body, mac] = t.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ d: 'other', t: 'acme', exp: 9e9 })).toString('base64url');
  assert.equal(readToken(`${forgedBody}.${mac}`), null);
  assert.equal(readToken(`${body}.${mac.slice(0, -2)}xx`), null);
  assert.equal(readToken(makeToken({ d: 'k1' }, -10)), null, 'expired');
  assert.equal(readToken('garbage'), null);
});

test('reconcile accepts consistent documents and names the problem otherwise', () => {
  assert.deepEqual(reconcile(makeInvoice({ rows: 30, seed: 3 })), []);
  assert.deepEqual(reconcile(makePurchaseOrder({ rows: 500, seed: 4 })), []);
  const bad = makeInvoice({ rows: 5, seed: 3 });
  bad.data.totals.grand_total += 1;
  assert.match(reconcile(bad)[0], /grand_total/);
  const wrongTax = makeInvoice({ rows: 2, seed: 3 }); // seed 3 => intra-state buyer
  wrongTax.data.items[0].igst = 5;
  wrongTax.data.items[0].total += 5;
  assert.ok(reconcile(wrongTax).some((p) => /intra-state but IGST/.test(p)));
});

test('planChunks covers every row exactly once, marks first/last', () => {
  const items = Array.from({ length: 1001 }, (_, i) => i);
  const chunks = planChunks(items, 250);
  assert.equal(chunks.length, 5);
  assert.deepEqual(chunks.flatMap((c) => c.rows), items);
  assert.equal(chunks[0].isFirst, true);
  assert.equal(chunks.filter((c) => c.isFirst).length, 1);
  assert.equal(chunks.at(-1).isLast, true);
  assert.equal(chunks.filter((c) => c.isLast).length, 1);
  assert.deepEqual([chunks[1].from, chunks[1].to], [251, 500]);
  assert.equal(planChunks(items.slice(0, 10), undefined).length, 1);
});

test('chunk plan: heavy docs chunk from the start; any doc chunks smaller on each retry', async () => {
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379/15';
  const { chunkPlan } = await import('../src/queue/worker.js').catch(() => ({}));
  if (!chunkPlan) return; // worker module needs its deps; covered in e2e
  assert.deepEqual(chunkPlan(50, 1), { heavy: false, chunkRows: undefined });
  assert.equal(chunkPlan(1000, 1).chunkRows, 250);
  assert.equal(chunkPlan(1000, 2).chunkRows, 125);
  assert.equal(chunkPlan(1000, 3).chunkRows, 62);
  assert.equal(chunkPlan(1000, 9).chunkRows, 40, 'never below MIN_CHUNK_ROWS');
  assert.equal(chunkPlan(200, 2).chunkRows, 100, 'a normal doc that crashed is retried in halves');
});

test('HTTP Range parsing', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=500-5000', 1000), { start: 500, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null, 'multi-range not supported => full body');
  assert.equal(parseRange('items=0-1', 1000), null);
});

test('semaphore is FIFO and never exceeds its limit', async () => {
  const s = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const order = [];
  await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const release = await s.acquire();
      active += 1;
      peak = Math.max(peak, active);
      order.push(i);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      release();
    }),
  );
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
});
