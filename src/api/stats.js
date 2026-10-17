// Live operational numbers for /v1/stats (console) and /metrics (Prometheus).
import { redis, keys, recentRate } from '../queue/queues.js';

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export async function collectStats(queues) {
  const r = redis();
  const [interactive, bulk, zip, logRaw] = await Promise.all([
    queues.interactive.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'),
    queues.bulk.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'),
    queues.zip.getJobCounts('waiting', 'active', 'completed', 'failed'),
    r.lrange(keys.renderLog, 0, 1999),
  ]);
  const workers = new Map(); // SCAN may return a key more than once
  let cursor = '0';
  do {
    const [next, found] = await r.scan(cursor, 'MATCH', keys.worker('*'), 'COUNT', 100);
    cursor = next;
    if (found.length) {
      for (const v of await r.mget(found)) {
        if (!v) continue;
        const w = JSON.parse(v);
        workers.set(w.id, w);
      }
    }
  } while (cursor !== '0');

  // Estimated queue wait = backlog / measured completions per second. This is
  // the autoscaling signal for burst workers (docs/deployment.md), not CPU:
  // bulk can saturate CPU harmlessly, a growing wait is what users feel.
  const [singleRate, bulkRate] = await Promise.all([recentRate('single', 10), recentRate('bulk', 30)]);
  const backlog = (c) => (c.waiting || 0) + (c.prioritized || 0) + (c.delayed || 0);
  const estWait = (n, rate) => (n === 0 ? 0 : rate > 0 ? +(n / rate).toFixed(2) : 999);
  const estimates = {
    interactive_wait_s: estWait(backlog(interactive), singleRate),
    bulk_wait_s: estWait(backlog(bulk), bulkRate),
    single_per_s: +singleRate.toFixed(2),
    bulk_per_s: +bulkRate.toFixed(2),
  };

  const now = Date.now();
  const log = logRaw.map((x) => JSON.parse(x));
  const lastMin = log.filter((e) => now - e.at < 60_000);
  const light = lastMin.filter((e) => !e.heavy).map((e) => e.ms);
  return {
    at: new Date(now).toISOString(),
    queues: { interactive, bulk, zip },
    renders: {
      last_minute: lastMin.length,
      p50_ms: pct(light, 50),
      p95_ms: pct(light, 95),
      heavy_last_minute: lastMin.filter((e) => e.heavy).length,
      retried_last_minute: lastMin.filter((e) => e.attempt > 1).length,
      recent: log.slice(0, 40),
    },
    estimates,
    workers: [...workers.values()],
  };
}

export function renderPrometheus(s) {
  const lines = [];
  const g = (name, help, rows) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, v] of rows) lines.push(`${name}${labels} ${v ?? 0}`);
  };
  const qrows = [];
  for (const [q, counts] of Object.entries(s.queues)) for (const [state, v] of Object.entries(counts)) qrows.push([`{queue="${q}",state="${state}"}`, v]);
  g('pdfsvc_queue_jobs', 'Jobs per queue and state', qrows);
  g('pdfsvc_estimated_wait_seconds', 'Queue backlog / measured throughput. Autoscaling signal for burst workers.', [
    ['{queue="interactive"}', s.estimates.interactive_wait_s],
    ['{queue="bulk"}', s.estimates.bulk_wait_s],
  ]);
  g('pdfsvc_renders_last_minute', 'PDFs rendered in the last 60s', [['', s.renders.last_minute]]);
  g('pdfsvc_render_ms', 'Render latency of normal documents, last 60s', [
    ['{quantile="0.5"}', s.renders.p50_ms],
    ['{quantile="0.95"}', s.renders.p95_ms],
  ]);
  g('pdfsvc_browser_memory_mb', 'Chromium process-tree memory (PSS) per worker', s.workers.map((w) => [`{worker="${w.id}"}`, w.pool.memMb]));
  g('pdfsvc_browser_crashes_total', 'Chromium crashes per worker since start', s.workers.map((w) => [`{worker="${w.id}"}`, w.pool.crashes]));
  g('pdfsvc_browser_recycles_total', 'Planned Chromium recycles per worker', s.workers.map((w) => [`{worker="${w.id}"}`, w.pool.recycles]));
  g('pdfsvc_pool_busy', 'Busy render slots per worker', s.workers.map((w) => [`{worker="${w.id}"}`, w.pool.busy]));
  return `${lines.join('\n')}\n`;
}
