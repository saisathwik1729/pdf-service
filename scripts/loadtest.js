// Open-loop load test at the brief's peak profile.
//   node scripts/loadtest.js --rate 1000 --duration 60 --bulk-per-min 6
// Singles arrive on a fixed schedule (open loop: a slow server does NOT slow
// the arrivals down, which is what real users do). Bulk jobs of 100 run
// concurrently. Writes docs/loadtest-results.json.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeInvoice, makePurchaseOrder } from '../src/lib/samples.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const KEY = process.env.API_KEY || 'demo-key';
const RATE = arg('rate', 1000); // singles per minute
const DURATION = arg('duration', 60); // seconds
const BULK_PER_MIN = arg('bulk-per-min', 6);
const BULK_SIZE = arg('bulk-size', 100);
const H = { 'content-type': 'application/json', 'x-api-key': KEY };
// Bulk jobs come from many customers in reality; spread them over N tenant keys
// (server needs API_KEYS=demo:demo-key,t1:k1,...,tN:kN) so the per-tenant cap of
// concurrent bulk jobs is not what the test measures.
const TENANTS = arg('tenants', 1);
const bulkKey = (i) => (TENANTS > 1 ? `k${(i % TENANTS) + 1}` : KEY);

const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pre-build every payload so the generator does not compete for CPU mid-test.
const seed0 = Math.floor(Math.random() * 1e6) * 10;
const nSingles = Math.round((RATE / 60) * DURATION);
const singles = Array.from({ length: nSingles }, (_, i) =>
  JSON.stringify(i % 10 === 0 ? makePurchaseOrder({ rows: 30 + (i % 50), seed: seed0 + i }) : makeInvoice({ rows: 6 + (i % 15), seed: seed0 + i })),
);
const nBulks = Math.max(0, Math.round((BULK_PER_MIN / 60) * DURATION));
const bulks = Array.from({ length: nBulks }, (_, b) =>
  JSON.stringify({
    label: `load-${b}`,
    documents: Array.from({ length: BULK_SIZE }, (_, i) => {
      const s = seed0 + 5_000_000 + b * 1000 + i;
      // ~5% large orders (500 lines) to exercise the heavy lane under load
      return i % 20 === 19 ? makePurchaseOrder({ rows: 500, seed: s }) : i % 2 ? makePurchaseOrder({ rows: 25, seed: s }) : makeInvoice({ rows: 10, seed: s });
    }),
  }),
);
console.log(`prepared ${nSingles} singles (${RATE}/min for ${DURATION}s) and ${nBulks} bulk jobs x ${BULK_SIZE}`);

const results = { singles: [], bulks: [], samples: [] };

async function oneSingle(body) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/documents?wait=4500`, { method: 'POST', headers: H, body });
    let j = await res.json();
    const firstResponseMs = performance.now() - t0;
    if (res.status === 429) return results.singles.push({ status: 429, firstResponseMs });
    while (j.status !== 'done' && j.status !== 'failed') {
      await sleep(500);
      j = await (await fetch(j.status_url)).json();
    }
    // "Download starts" = the moment a ready link is in hand (the next GET is a static file read).
    results.singles.push({ status: res.status, firstResponseMs, readyMs: performance.now() - t0, done: j.status === 'done', cached: !!j.cached });
  } catch (err) {
    results.singles.push({ status: 'error', error: err.message, readyMs: performance.now() - t0 });
  }
}

async function oneBulk(body, i) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1/bulk`, { method: 'POST', headers: { ...H, 'x-api-key': bulkKey(i) }, body });
  const j = await res.json();
  if (res.status !== 202) return results.bulks.push({ status: res.status, error: j.error });
  let v;
  for (;;) {
    await sleep(1000);
    v = await (await fetch(j.status_url)).json();
    if (['done', 'partial', 'failed'].includes(v.status)) break;
  }
  results.bulks.push({ status: v.status, done: v.done, failed: v.failed, totalSec: +((performance.now() - t0) / 1000).toFixed(1), parts: v.parts.length });
}

const sampler = setInterval(async () => {
  try {
    const s = await (await fetch(`${BASE}/v1/stats`)).json();
    results.samples.push({
      t: Date.now(),
      interactiveWaiting: s.queues.interactive.waiting + (s.queues.interactive.prioritized || 0),
      bulkWaiting: s.queues.bulk.waiting + (s.queues.bulk.prioritized || 0),
      memMb: s.workers.reduce((a, w) => a + (w.pool.memMb || 0), 0),
      crashes: s.workers.reduce((a, w) => a + (w.pool.crashes || 0), 0),
    });
  } catch {}
}, 2000);

const started = performance.now();
const inflight = [];
// bulk jobs spread evenly across the window
bulks.forEach((b, i) => inflight.push(sleep((i * DURATION * 1000) / Math.max(1, nBulks)).then(() => oneBulk(b, i))));
// singles on a fixed schedule
const interval = 60000 / RATE;
for (let i = 0; i < nSingles; i += 1) {
  const due = started + i * interval;
  const wait = due - performance.now();
  if (wait > 1) await sleep(wait);
  inflight.push(oneSingle(singles[i]));
}
await Promise.all(inflight);
clearInterval(sampler);

const s = results.singles;
const ready = s.filter((x) => x.done).map((x) => x.readyMs);
const summary = {
  machine: { cpus: os.cpus().length, model: os.cpus()[0]?.model, note: 'load generator, API, worker, Chromium and Redis all share this machine' },
  profile: { singlesPerMin: RATE, durationSec: DURATION, bulkPerMin: BULK_PER_MIN, bulkSize: BULK_SIZE, bulkTenants: TENANTS },
  singles: {
    sent: s.length,
    done: ready.length,
    rejected429: s.filter((x) => x.status === 429).length,
    errors: s.filter((x) => x.status === 'error').length,
    within5sPct: +((ready.filter((x) => x <= 5000).length / Math.max(1, s.length)) * 100).toFixed(2),
    answeredInline200Pct: +((s.filter((x) => x.status === 200).length / Math.max(1, s.length)) * 100).toFixed(1),
    readyMs: { p50: pct(ready, 50), p95: pct(ready, 95), p99: pct(ready, 99), max: pct(ready, 100) },
  },
  bulks: results.bulks,
  peaks: {
    interactiveQueue: Math.max(0, ...results.samples.map((x) => x.interactiveWaiting)),
    bulkQueue: Math.max(0, ...results.samples.map((x) => x.bulkWaiting)),
    chromiumMemMb: Math.max(0, ...results.samples.map((x) => x.memMb)),
    crashes: Math.max(0, ...results.samples.map((x) => x.crashes)),
  },
  wallSec: +((performance.now() - started) / 1000).toFixed(1),
};
console.log(JSON.stringify(summary, null, 2));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', process.env.LOADTEST_OUT || 'loadtest-results.json');
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`wrote ${out}`);
