// Chaos test: kill Chromium (like the kernel OOM-killer would) in the middle of
// a bulk job and check every document still comes out. Linux only.
//   node scripts/chaos.js
import { execSync } from 'node:child_process';
import { makePurchaseOrder, makeInvoice } from '../src/lib/samples.js';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const KEY = process.env.API_KEY || 'demo-key';
const seed0 = Date.now() % 1_000_000;
const docs = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? makePurchaseOrder({ rows: 700, seed: seed0 + i }) : makeInvoice({ rows: 15, seed: seed0 + i })));

const job = await (await fetch(`${BASE}/v1/bulk`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ label: 'chaos', documents: docs }) })).json();
console.log('bulk', job.bulk_id);

const browserPids = () =>
  execSync('ps -eo pid,args')
    .toString()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([, bin, ...args]) => /^(headless_shell|chrome|chromium)/.test((bin || '').split('/').pop()) && !args.some((a) => a.startsWith('--type=')))
    .map(([pid]) => Number(pid))
    .filter(Boolean);

let kills = 0;
for (const delay of [1500, 2500]) {
  await new Promise((r) => setTimeout(r, delay));
  const pids = browserPids();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      kills += 1;
    } catch {}
  }
  console.log(`t+${delay}ms: SIGKILLed chromium ${pids.join(',')}`);
}

let view;
for (;;) {
  view = await (await fetch(job.status_url)).json();
  if (['done', 'partial', 'failed'].includes(view.status)) break;
  await new Promise((r) => setTimeout(r, 500));
}
const retried = view.items.filter((i) => (i.attempt || 1) > 1).length;
console.log(`result: ${view.status} ${view.done}/${view.total} done, ${view.failed} failed; ${kills} kills; items needing a retry: ${retried}`);
const stats = await (await fetch(`${BASE}/v1/stats`)).json();
console.log('pool:', stats.workers.map((w) => ({ launches: w.pool.launches, crashes: w.pool.crashes })));
process.exit(view.failed ? 1 : 0);
