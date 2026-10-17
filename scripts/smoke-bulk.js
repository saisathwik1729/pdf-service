// Bulk end-to-end: 100 mixed documents, follow progress over SSE, fetch zip
// parts, verify one PDF and a tampered copy.  `node scripts/smoke-bulk.js [n]`
import { makeInvoice, makePurchaseOrder } from '../src/lib/samples.js';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const KEY = process.env.API_KEY || 'demo-key';
const N = Number(process.argv[2] || 100);
const seed0 = Date.now() % 1_000_000;
const docs = Array.from({ length: N }, (_, i) =>
  i % 10 === 9 ? makePurchaseOrder({ rows: 600, seed: seed0 + i }) : i % 2 ? makePurchaseOrder({ rows: 30, seed: seed0 + i }) : makeInvoice({ rows: 12, seed: seed0 + i }),
);
const body = JSON.stringify({ label: 'October GST invoices', documents: docs });
const t0 = Date.now();
const res = await fetch(`${BASE}/v1/bulk`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body });
const job = await res.json();
console.log('submit', res.status, `${(body.length / 1048576).toFixed(1)}MB payload`, `${Date.now() - t0}ms`, job.bulk_id);

// Minimal SSE reader
const es = await fetch(job.events_url);
const reader = es.body.getReader();
const dec = new TextDecoder();
let buf = '';
let last = 0;
let final = null;
while (!final) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const ev = /event: (\w+)/.exec(chunk)?.[1];
    const data = /data: (.*)/.exec(chunk)?.[1];
    if (!ev || !data) continue;
    const d = JSON.parse(data);
    if (ev === 'item' && d.done !== undefined && (d.done + d.failed) - last >= 20) {
      last = d.done + d.failed;
      console.log(`  progress ${d.done}/${N} done, ${d.failed} failed  t+${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (ev === 'snapshot' && ['done', 'partial', 'failed'].includes(d.status)) final = d;
  }
}
reader.cancel().catch(() => {});
console.log('final', final.status, `${final.done}/${final.total}`, `${((Date.now() - t0) / 1000).toFixed(1)}s`, 'parts:', final.parts.map((p) => `${p.name} ${(p.bytes / 1048576).toFixed(1)}MB`));

const part = await fetch(final.parts[0].url);
const zip = Buffer.from(await part.arrayBuffer());
console.log('zip part 1', part.status, zip.length, 'bytes');

const item = final.items.find((i) => i.status === 'done');
const pdf = Buffer.from(await (await fetch(item.download_url)).arrayBuffer());
const v1 = await (await fetch(`${BASE}/v1/verify`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdf })).json();
console.log('verify original:', v1.result);
const tampered = Buffer.from(pdf);
const at = tampered.indexOf(Buffer.from('/Producer'));
tampered[at + 12] ^= 1; // flip one bit in the metadata
const v2 = await (await fetch(`${BASE}/v1/verify`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: tampered })).json();
console.log('verify tampered:', v2.result, '-', v2.message);
process.exit(0);
