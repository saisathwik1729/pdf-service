// Measures what a PDF actually costs, so capacity planning uses real numbers.
//   node scripts/bench.js            -> prints tables + writes docs/benchmark-results.json
//
// A. cold   : launch Chromium -> render -> close, per PDF (the naive model)
// B. warm   : one long-lived browser, fresh page per render, by line-item count
// C. chunked: same large docs rendered in 250-row chunks + merged
// D. thrpt  : warm pool throughput for a typical invoice at concurrency 1/2/4
// Peak memory = Chromium process-tree RSS, sampled every 25ms during the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { BrowserPool, processTreeRssMb } from '../src/render/browserPool.js';
import { renderDocument } from '../src/render/renderer.js';
import { makeInvoice, makePurchaseOrder } from '../src/lib/samples.js';
import { config } from '../src/config.js';

const exe = config.render.executablePath;
const quiet = { info() {}, warn() {}, error() {} };
const meta = () => ({
  docKey: 'bench0000000000000000000000000000',
  snapshotAt: '2026-10-16T05:12:00Z',
  generatedAt: new Date().toISOString(),
  verifyUrl: 'http://localhost:8080/verify?doc=bench',
  templateVersion: config.templateVersion,
});
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function sampler(getPid) {
  let peak = 0;
  const t = setInterval(() => {
    const r = processTreeRssMb(getPid());
    if (r && r > peak) peak = r;
  }, 25);
  return { stop: () => (clearInterval(t), peak) };
}

async function cold(n) {
  const times = [];
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const doc = makeInvoice({ rows: 10, seed: i + 1 });
    const t0 = performance.now();
    const browser = await puppeteer.launch({ executablePath: exe, headless: config.render.headless === 'true' ? true : config.render.headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const s = sampler(() => browser.process()?.pid);
    const fakePool = {
      async withPage(fn) {
        const page = await browser.newPage();
        try {
          return await fn(page);
        } finally {
          await page.close();
        }
      },
    };
    await renderDocument(fakePool, doc, meta(), {});
    peak = Math.max(peak, s.stop());
    await browser.close();
    times.push(performance.now() - t0);
  }
  return { n, p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), peakRssMb: peak };
}

async function bySize(pool, rowsList, chunkRows) {
  const rowsOut = [];
  for (const rows of rowsList) {
    const doc = makePurchaseOrder({ rows, seed: rows });
    // settle: fresh browser per size so one size's garbage does not pollute the next
    await pool.close();
    await pool.start();
    const base = processTreeRssMb(pool.current.browser.process()?.pid);
    const s = sampler(() => pool.current?.browser.process()?.pid);
    let r;
    let err = null;
    try {
      r = await renderDocument(pool, doc, meta(), { chunkRows, timeoutMs: 120000 });
    } catch (e) {
      err = e.message;
    }
    const peak = s.stop();
    rowsOut.push({
      rows,
      chunkRows: chunkRows || rows,
      ms: r?.timings.totalMs ?? null,
      pages: r?.pages ?? null,
      kb: r ? Math.round(r.bytes.length / 1024) : null,
      idleRssMb: base,
      peakRssMb: peak,
      deltaMb: peak - base,
      error: err,
    });
    console.log(JSON.stringify(rowsOut.at(-1)));
  }
  return rowsOut;
}

async function throughput(pool, conc, total) {
  await pool.close();
  await pool.start();
  const lat = [];
  let next = 0;
  const s = sampler(() => pool.current?.browser.process()?.pid);
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < total) {
        const i = next++;
        const a = performance.now();
        await renderDocument(pool, makeInvoice({ rows: 12, seed: i + 1 }), meta(), {});
        lat.push(performance.now() - a);
      }
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  return { concurrency: conc, renders: total, pdfPerSec: +(total / secs).toFixed(2), pdfPerMin: Math.round((total / secs) * 60), p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), peakRssMb: s.stop() };
}

const results = { browser: { executablePath: exe, headless: config.render.headless }, machine: { cpus: os.cpus().length, model: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 1e9) }, at: new Date().toISOString() };

console.log('A. cold start per PDF');
results.cold = await cold(5);
console.log(results.cold);

const pool = new BrowserPool({ executablePath: exe, headless: config.render.headless, size: 4, logger: quiet, maxRendersPerBrowser: 100000, rssLimitMb: 100000 });
await pool.start();

console.log('B. warm, unchunked, by line items');
results.warm = await bySize(pool, [5, 50, 200, 500, 1000, 2000, 4000], undefined);

console.log('C. warm, chunked (250 rows)');
results.chunked = await bySize(pool, [500, 1000, 2000, 4000], 250);

console.log('D. throughput, typical 12-line invoice');
results.throughput = [];
for (const c of [1, 2, 3, 4]) {
  results.throughput.push(await throughput(pool, c, 60));
  console.log(results.throughput.at(-1));
}
await pool.close();

const outFile = path.join(config.root, 'docs', process.env.BENCH_OUT || 'benchmark-results.json');
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`wrote ${outFile}`);
