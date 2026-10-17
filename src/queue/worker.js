// Worker process: owns Chromium, consumes the three queues.
// Runs separately from the API so a Chromium crash or a memory spike can never
// take down the process that is accepting requests.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'bullmq';
import { ZipArchive } from 'archiver';
import pino from 'pino';
import { config } from '../config.js';
import { BrowserPool } from '../render/browserPool.js';
import { renderDocument } from '../render/renderer.js';
import { Semaphore } from '../lib/semaphore.js';
import { sha256, signRecord, hmacHex, makeToken } from '../lib/crypto.js';
import { storage, archiveKey } from '../storage/index.js';
import {
  redis,
  redisConnection,
  getQueues,
  keys,
  getDoc,
  putDoc,
  getBulk,
  saveBulk,
  getBulkItems,
  setBulkItem,
  publishBulkEvent,
  publishDocEvent,
  logRender,
} from './queues.js';

const log = pino({ name: 'pdf-worker', level: process.env.LOG_LEVEL || 'info' });
const workerId = `${os.hostname()}-${process.pid}`;

const pool = new BrowserPool({
  executablePath: config.render.executablePath,
  headless: config.render.headless,
  size: config.render.poolSize,
  maxRendersPerBrowser: config.render.maxRendersPerBrowser,
  rssLimitMb: config.render.browserRssLimitMb,
  logger: log,
});
// At most N heavy (chunked) documents at once per worker, regardless of
// which queue they came from. This is what bounds worst-case memory.
const heavyLane = new Semaphore(config.render.heavyConcurrency);

/**
 * How to render a document on a given attempt.
 * Attempt 1: normal docs in one go; heavy docs in chunks of CHUNK_ROWS.
 * Retries : always chunked, halving chunk size each time (adaptive), so a
 *           document that crashed Chromium gets progressively smaller bites.
 */
export function chunkPlan(rows, attempt) {
  const { heavyRowThreshold, chunkRows, minChunkRows } = config.render;
  const heavy = rows > heavyRowThreshold;
  if (!heavy && attempt <= 1) return { heavy, chunkRows: undefined };
  const base = heavy ? chunkRows : rows;
  const size = Math.max(minChunkRows, Math.floor(base / 2 ** Math.max(0, attempt - 1)));
  return { heavy, chunkRows: size >= rows ? undefined : size };
}

async function loadDoc(job) {
  if (job.data.doc) return job.data.doc;
  return storage().getJson(job.data.payloadKey);
}

/** Render (or reuse) one document, archive it, sign it. Returns the record. */
async function renderAndStore(job, doc) {
  const { tenantId, docKey, snapshotAt, kind } = job.data;
  const existing = await getDoc(docKey);
  if (existing?.status === 'done') return { record: existing, cached: true };

  const attempt = job.attemptsMade + 1;
  const rows = doc.data.items.length;
  const plan = chunkPlan(rows, attempt);
  const generatedAt = new Date().toISOString();
  await putDoc({ ...(existing || {}), doc_key: docKey, tenant_id: tenantId, status: 'rendering', attempt, heavy: plan.heavy, rows });

  const meta = {
    docKey,
    snapshotAt,
    generatedAt,
    templateVersion: config.templateVersion,
    verifyUrl: `${config.publicBaseUrl}/verify?doc=${docKey}`,
  };
  const release = plan.heavy ? await heavyLane.acquire() : null;
  let result;
  try {
    result = await renderDocument(pool, doc, meta, {
      chunkRows: plan.chunkRows,
      timeoutMs: plan.heavy ? config.render.renderTimeoutMs * 4 : config.render.renderTimeoutMs,
    });
  } finally {
    release?.();
  }

  const digest = sha256(result.bytes);
  const base = `${archiveKey(tenantId, docKey, generatedAt)}-${digest.slice(0, 12)}`;
  const signed = signRecord({
    v: 1,
    doc_key: docKey,
    tenant_id: tenantId,
    document_id: doc.document_id ?? null,
    type: doc.type,
    number: doc.data.number,
    data_version: doc.version ?? null,
    snapshot_at: snapshotAt,
    generated_at: generatedAt,
    template_version: config.templateVersion,
    sha256: digest,
    bytes: result.bytes.length,
    pages: result.pages,
    storage_key: `${base}.pdf`,
  });
  // PDF first, then its record: a record never points at a missing PDF.
  await storage().put(`${base}.pdf`, result.bytes, { retain: true });
  await storage().putJson(`${base}.json`, signed, { retain: true });
  // Durable fingerprint index for verification (years after Redis forgot it).
  await storage().putJson(`index/sha256/${digest}.json`, { doc_key: docKey, record_key: `${base}.json` }, { retain: true });

  const record = {
    ...signed,
    record_key: `${base}.json`,
    status: 'done',
    attempt,
    heavy: plan.heavy,
    chunks: result.chunks,
    rows,
    render_ms: result.timings.totalMs,
  };
  await putDoc(record);
  await logRender({ at: Date.now(), kind, ms: result.timings.totalMs, rows, pages: result.pages, bytes: result.bytes.length, heavy: plan.heavy, chunks: result.chunks, attempt });
  log.info({ docKey, kind, rows, pages: result.pages, chunks: result.chunks, ms: result.timings.totalMs, attempt }, 'rendered');
  return { record, cached: false };
}

// ----------------------------------------------------------- processors ---

async function processInteractive(job) {
  const doc = await loadDoc(job);
  const { record, cached } = await renderAndStore(job, doc);
  await publishDocEvent(job.data.docKey, { status: 'done', cached });
  return { docKey: record.doc_key, cached };
}

async function processBulkItem(job) {
  const { bulkId, index } = job.data;
  const bulk = await getBulk(bulkId);
  if (!bulk || bulk.status === 'cancelled') return { skipped: true };
  if (!bulk.started_at) {
    bulk.started_at = new Date().toISOString();
    bulk.status = 'running';
    await saveBulk(bulk);
  }
  const doc = await loadDoc(job);
  const base = { index, doc_key: job.data.docKey, document_id: doc.document_id ?? null, type: doc.type, number: doc.data.number, rows: doc.data.items.length };
  await setBulkItem(bulkId, { ...base, status: 'rendering', attempt: job.attemptsMade + 1 });
  await publishBulkEvent(bulkId, { type: 'item', index, status: 'rendering' });

  const { record, cached } = await renderAndStore(job, doc);

  await setBulkItem(bulkId, { ...base, status: 'done', cached, attempt: job.attemptsMade + 1, chunks: record.chunks, bytes: record.bytes, pages: record.pages, sha256: record.sha256, ms: record.render_ms });
  const r = redis();
  await r.multi().sadd(keys.bulkDone(bulkId), String(index)).srem(keys.bulkFailed(bulkId), String(index)).exec();
  await announceProgress(bulkId, { type: 'item', index, status: 'done', cached, pages: record.pages, bytes: record.bytes });
  await maybeFinish(bulkId);
  return { docKey: record.doc_key, cached };
}

async function announceProgress(bulkId, event) {
  const r = redis();
  const [done, failed] = await Promise.all([r.scard(keys.bulkDone(bulkId)), r.scard(keys.bulkFailed(bulkId))]);
  await publishBulkEvent(bulkId, { ...event, done, failed });
}

async function maybeFinish(bulkId) {
  const bulk = await getBulk(bulkId);
  if (!bulk) return;
  if (bulk.done + bulk.failed >= bulk.total && !['zipping', 'done', 'partial', 'failed'].includes(bulk.status)) {
    // jobId makes this idempotent if several items finish at the same instant.
    await getQueues().zip.add('zip', { bulkId }, { jobId: `zip-${bulkId}-${bulk.generation || 1}` });
  }
}

async function onFailed(job, err, queueName) {
  if (!job) return;
  const final = job.attemptsMade >= (job.opts.attempts || 1);
  log.warn({ queue: queueName, jobId: job.id, attempt: job.attemptsMade, final, err: err.message }, 'job failed');
  if (queueName === config.queue.interactiveName) {
    if (final) {
      const existing = (await getDoc(job.data.docKey)) || {};
      await putDoc({ ...existing, doc_key: job.data.docKey, status: 'failed', error: err.message });
      await publishDocEvent(job.data.docKey, { status: 'failed', error: err.message });
    }
    return;
  }
  if (queueName === config.queue.bulkName) {
    const { bulkId, index } = job.data;
    const items = await redis().hget(keys.bulkItems(bulkId), String(index));
    const item = items ? JSON.parse(items) : { index };
    if (final) {
      await setBulkItem(bulkId, { ...item, status: 'failed', error: err.message, attempt: job.attemptsMade });
      await redis().sadd(keys.bulkFailed(bulkId), String(index));
      const existing = (await getDoc(job.data.docKey)) || {};
      await putDoc({ ...existing, doc_key: job.data.docKey, status: 'failed', error: err.message });
      await announceProgress(bulkId, { type: 'item', index, status: 'failed', error: err.message });
      await maybeFinish(bulkId);
    } else {
      await setBulkItem(bulkId, { ...item, status: 'retrying', error: err.message, attempt: job.attemptsMade });
      await announceProgress(bulkId, { type: 'item', index, status: 'retrying', error: err.message, attempt: job.attemptsMade });
    }
  }
}

const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function buildZip(entries) {
  const archive = new ZipArchive({ store: true }); // PDFs are already compressed; don't burn CPU
  const chunks = [];
  archive.on('data', (c) => chunks.push(c));
  const finished = new Promise((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const e of entries) archive.append(e.body, { name: e.name, date: new Date(e.date || Date.now()) });
  await archive.finalize();
  await finished;
  return Buffer.concat(chunks);
}

async function processZip(job) {
  const { bulkId } = job.data;
  const bulk = await getBulk(bulkId);
  if (!bulk) return;
  bulk.status = 'zipping';
  await saveBulk(bulk);
  await publishBulkEvent(bulkId, { type: 'status', status: 'zipping', done: bulk.done, failed: bulk.failed });

  const items = await getBulkItems(bulkId);
  const ok = items.filter((i) => i.status === 'done');
  const failed = items.filter((i) => i.status === 'failed');

  // Split into parts of <= ZIP_PART_MAX_MB. A user on a flaky connection
  // re-downloads at most one part, and each part resumes via HTTP Range.
  const groups = [];
  let cur = [];
  let curBytes = 0;
  for (const it of ok) {
    if (cur.length && curBytes + it.bytes > config.storage.zipPartMaxBytes) {
      groups.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(it);
    curBytes += it.bytes;
  }
  if (cur.length) groups.push(cur);

  const label = safeName(bulk.label) || 'documents';
  const parts = [];
  for (let p = 0; p < groups.length; p += 1) {
    const entries = [];
    const manifestFiles = [];
    for (const it of groups[p]) {
      const rec = await getDoc(it.doc_key);
      const body = await storage().getBuffer(rec.storage_key);
      const name = `${String(it.index + 1).padStart(3, '0')}_${it.type === 'invoice' ? 'INV' : 'PO'}_${safeName(it.number)}.pdf`;
      entries.push({ name, body, date: rec.generated_at });
      const { status, attempt, heavy, chunks, rows, render_ms, record_key, ...signedRecord } = rec;
      manifestFiles.push({ file: name, ...signedRecord });
    }
    const manifest = {
      bulk_id: bulkId,
      label: bulk.label || null,
      part: p + 1,
      of: groups.length,
      snapshot_at: bulk.snapshot_at,
      created_at: bulk.created_at,
      verify: `${config.publicBaseUrl}/verify`,
      public_key: `${config.publicBaseUrl}/v1/keys`,
      note: 'Each file entry is a signed record (Ed25519). sha256 must match the file; the signature covers the record.',
      files: manifestFiles,
      failed: p === 0 ? failed.map((f) => ({ index: f.index, document_id: f.document_id, number: f.number, error: f.error })) : undefined,
    };
    entries.push({ name: 'MANIFEST.json', body: Buffer.from(JSON.stringify(manifest, null, 2)) });
    entries.push({ name: 'SHA256SUMS', body: Buffer.from(manifestFiles.map((f) => `${f.sha256}  ${f.file}`).join('\n') + '\n') });
    const zip = await buildZip(entries);
    const name = groups.length > 1 ? `${label}_${bulkId.slice(0, 8)}_part${p + 1}of${groups.length}.zip` : `${label}_${bulkId.slice(0, 8)}.zip`;
    const key = `bulk/${bulkId}/${name}`;
    await storage().put(key, zip, { contentType: 'application/zip' });
    parts.push({ name, key, bytes: zip.length, sha256: sha256(zip), files: groups[p].length });
  }

  const latest = await getBulk(bulkId);
  latest.parts = parts;
  latest.status = ok.length === 0 ? 'failed' : failed.length ? 'partial' : 'done';
  latest.finished_at = new Date().toISOString();
  await saveBulk(latest);
  await redis().srem(keys.tenantActive(latest.tenant_id), bulkId);
  await publishBulkEvent(bulkId, { type: 'status', status: latest.status, done: latest.done, failed: latest.failed, parts: parts.length });
  log.info({ bulkId, status: latest.status, parts: parts.length, ok: ok.length, failed: failed.length }, 'bulk finished');
  if (latest.callback_url) await sendWebhook(latest);
  return { parts: parts.length };
}

// Tell the ERP the bulk job is done. Signed with HMAC so Django can trust it.
// Failures here never fail the bulk job: the ERP can always poll.
async function sendWebhook(bulk) {
  const token = makeToken({ b: bulk.id, t: bulk.tenant_id });
  const body = JSON.stringify({
    event: 'bulk.completed',
    bulk_id: bulk.id,
    status: bulk.status,
    total: bulk.total,
    done: bulk.done,
    failed: bulk.failed,
    status_url: `${config.publicBaseUrl}/v1/bulk/${bulk.id}?token=${token}`,
    parts: bulk.parts.map((p, i) => ({ name: p.name, bytes: p.bytes, sha256: p.sha256, url: `${config.publicBaseUrl}/v1/bulk/${bulk.id}/parts/${i}?token=${token}` })),
  });
  const ts = Math.floor(Date.now() / 1000);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(bulk.callback_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pdfsvc-timestamp': String(ts), 'x-pdfsvc-signature': `sha256=${hmacHex(config.auth.webhookSecret, `${ts}.${body}`)}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      log.warn({ status: res.status, attempt }, 'webhook non-2xx');
    } catch (err) {
      log.warn({ err: err.message, attempt }, 'webhook failed');
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

// ---------------------------------------------------------------- start ---

export async function startWorker() {
  await pool.start();
  const connection = redisConnection();
  const workers = [
    new Worker(config.queue.interactiveName, processInteractive, { connection, concurrency: config.render.poolSize }),
    new Worker(config.queue.bulkName, processBulkItem, { connection: redisConnection(), concurrency: config.render.bulkConcurrency }),
    new Worker(config.queue.zipName, processZip, { connection: redisConnection(), concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => onFailed(job, err, w.name).catch((e) => log.error({ err: e.message }, 'onFailed error')));
    w.on('error', (err) => log.error({ err: err.message, queue: w.name }, 'worker error'));
  }

  // Heartbeat: lets the API / console show live pool and memory stats.
  const beat = setInterval(() => {
    const snap = { id: workerId, at: Date.now(), pool: pool.snapshot(), heapMb: Math.round(process.memoryUsage().rss / 1048576), poolSize: config.render.poolSize, bulkConcurrency: config.render.bulkConcurrency };
    redis().set(keys.worker(workerId), JSON.stringify(snap), 'EX', 10).catch(() => {});
  }, 2000);

  log.info({ workerId, poolSize: config.render.poolSize, bulkConcurrency: config.render.bulkConcurrency, heavyThreshold: config.render.heavyRowThreshold }, 'worker started');

  const shutdown = async (sig) => {
    log.info({ sig }, 'shutting down: finishing active jobs');
    clearInterval(beat);
    await Promise.allSettled(workers.map((w) => w.close()));
    await pool.close();
    await redis().quit().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { workers, pool };
}

// Works on Windows too: compare file URLs, not hand-built strings.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startWorker().catch((err) => {
    log.error({ err: err.message, stack: err.stack }, 'worker failed to start');
    process.exit(1);
  });
}
