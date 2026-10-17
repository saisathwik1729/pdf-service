// End-to-end smoke test against a running stack: `node scripts/smoke.js`
import { makeInvoice, makePurchaseOrder } from '../src/lib/samples.js';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const KEY = process.env.API_KEY || 'demo-key';
const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, ...headers }, body: JSON.stringify(body) });

const t0 = Date.now();
const r = await post('/v1/documents', makeInvoice({ rows: 10, seed: Date.now() % 100000 }));
const j = await r.json();
console.log('single   ', r.status, j.status, `${Date.now() - t0}ms`, j.pages, 'pages', j.bytes, 'bytes', j.sha256?.slice(0, 12));
const again = await (await post('/v1/documents', makeInvoice({ rows: 10, seed: Date.now() % 100000 }))).json();
const d = await fetch(j.download_url);
console.log('download ', d.status, d.headers.get('content-type'), d.headers.get('content-length'));
const p = await fetch(j.download_url, { headers: { range: 'bytes=100-199' } });
console.log('range    ', p.status, p.headers.get('content-range'), (await p.arrayBuffer()).byteLength);
const bad = makeInvoice({ rows: 3, seed: 2 });
bad.data.totals.grand_total += 500;
const b = await post('/v1/documents', bad);
console.log('mismatch ', b.status, (await b.json()).problems);
const heavy = await post('/v1/documents?wait=20000', makePurchaseOrder({ rows: 900, seed: Date.now() % 1000 }));
const hj = await heavy.json();
console.log('heavy PO ', heavy.status, hj.status, hj.pages, 'pages', hj.chunks, 'chunks', hj.render_ms, 'ms');
