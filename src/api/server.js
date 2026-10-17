// HTTP API. Never touches Chromium — it validates, enqueues, waits cheaply
// (async, no threads blocked) and serves files.
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { PDFDocument } from 'pdf-lib';
import { config } from '../config.js';
import { documentSchema, bulkSchema, reconcile } from '../lib/validate.js';
import { documentKey, makeToken, readToken, sha256, publicKeyInfo, verifyRecordSignature } from '../lib/crypto.js';
import { storage } from '../storage/index.js';
import {
  redis,
  getQueues,
  keys,
  getDoc,
  putDoc,
  lookupSha,
  getBulk,
  saveBulk,
  getBulkItems,
  setBulkItem,
  recentRate,
} from '../queue/queues.js';
import { EventHub } from './events.js';
import { sendStoredFile } from './files.js';
import { collectStats, renderPrometheus } from './stats.js';

const TITLES = { invoice: 'Tax Invoice', purchase_order: 'Purchase Order' };
const FINAL_BULK = ['done', 'partial', 'failed', 'cancelled'];

export async function buildServer({ logger = true } = {}) {
  const app = Fastify({
    logger: logger && { level: process.env.LOG_LEVEL || 'info', redact: ['req.headers["x-api-key"]', 'req.headers.authorization'] },
    bodyLimit: 32 * 1024 * 1024, // 100 POs x 500 lines of JSON is ~15MB
    trustProxy: true,
  });
  const hub = new EventHub();
  await hub.ready;
  const queues = getQueues();
  const base = config.publicBaseUrl;

  // Django sends optional fields as null (gstin, hsn, einvoice, callback_url...).
  // Treat null as "absent" so the schema doesn't reject B2C / non-e-invoice documents.
  const dropNulls = (v) => {
    if (Array.isArray(v)) return v.map(dropNulls);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (v[k] === null) delete v[k];
        else v[k] = dropNulls(v[k]);
      }
    }
    return v;
  };
  app.addHook('preValidation', async (req) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) dropNulls(req.body);
  });

  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  // --------------------------------------------------------------- auth ---
  const keyToTenant = new Map(config.auth.apiKeys.map(({ tenant, key }) => [key, tenant]));
  function apiTenant(req) {
    const h = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!h) return null;
    // constant-time compare against each configured key
    for (const [key, tenant] of keyToTenant) {
      const a = Buffer.from(String(h));
      const b = Buffer.from(key);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return tenant;
    }
    return null;
  }
  const requireApiKey = async (req, reply) => {
    const t = apiTenant(req);
    if (!t) return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid API key' });
    req.tenant = t;
  };
  /** API key OR a signed token whose claims satisfy `match`. */
  const keyOrToken = (match) => async (req, reply) => {
    const t = apiTenant(req);
    if (t) {
      req.tenant = t;
      return;
    }
    const claims = readToken(req.query.token);
    if (claims && match(claims, req)) {
      req.tenant = claims.t;
      req.viaToken = true;
      return;
    }
    return reply.code(401).send({ error: 'unauthorized', message: 'invalid or expired link' });
  };

  // Browser-facing GETs authenticate with a token in the URL, so allow
  // cross-origin reads (the ERP's own pages can fetch with Range to resume).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag, Accept-Ranges, Content-Disposition, Retry-After');
    }
    return payload;
  });
  app.options('/v1/*', async (_req, reply) =>
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Range, If-Range')
      .code(204)
      .send(),
  );

  // ------------------------------------------------- admission control ---
  // Estimated wait = queued single jobs / singles completed per second (last 10s,
  // all workers). Cached for 250ms so a burst costs Redis two calls, not thousands.
  let admission = { at: 0, backlog: 0, rate: 0, limit: config.queue.minInteractiveBacklog };
  async function admissionState() {
    if (Date.now() - admission.at < 250) return admission;
    const [c, rate] = await Promise.all([queues.interactive.getJobCounts('waiting', 'prioritized', 'delayed'), recentRate('single', 10)]);
    const backlog = (c.waiting || 0) + (c.prioritized || 0) + (c.delayed || 0);
    const limit = Math.min(config.queue.maxInteractiveBacklog, Math.max(config.queue.minInteractiveBacklog, Math.floor(rate * config.queue.maxQueueWaitSec)));
    admission = { at: Date.now(), backlog, rate, limit };
    return admission;
  }

  // ----------------------------------------------------------- helpers ---
  const docLinks = (rec, tenant) => {
    const token = makeToken({ d: rec.doc_key, t: tenant });
    return {
      download_url: `${base}/v1/documents/${rec.doc_key}/download?token=${token}`,
      status_url: `${base}/v1/documents/${rec.doc_key}?token=${token}`,
      verify_url: `${base}/verify?doc=${rec.doc_key}`,
    };
  };
  const publicDoc = (rec) => {
    if (!rec) return null;
    const { record_key, storage_key, tenant_id, ...rest } = rec;
    return rest;
  };
  const pdfFilename = (rec) => `${rec.type === 'invoice' ? 'Invoice' : 'PO'}_${String(rec.number || rec.doc_key).replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;

  function waitForDoc(docKey, ms) {
    return hub.waitOnce(keys.docEvents(docKey), ms, async () => {
      const r = await getDoc(docKey);
      return r && (r.status === 'done' || r.status === 'failed') ? { status: r.status } : null;
    });
  }

  // ======================================================== documents ===
  // POST /v1/documents?wait=4000
  // Single document. Holds the request up to `wait` ms for the render (cheap:
  // an async wait in Node, not a blocked thread), then answers 200 with links
  // (or the PDF itself if Accept: application/pdf) — or 202 if still running.
  app.post(
    '/v1/documents',
    { onRequest: requireApiKey, schema: { body: documentSchema, querystring: { type: 'object', properties: { wait: { type: 'integer', minimum: 0 } } } } },
    async (req, reply) => {
      const t0 = Date.now();
      const doc = req.body;
      const problems = reconcile(doc);
      if (problems.length) return reply.code(422).send({ error: 'totals_mismatch', message: 'Document totals do not reconcile with line items', problems });

      const tenant = req.tenant;
      const docKey = documentKey(tenant, doc);
      let rec = await getDoc(docKey);
      let enqueued = false;
      if (!rec || rec.status === 'failed') {
        const adm = await admissionState();
        if (adm.backlog >= adm.limit) {
          const retryAfter = Math.max(2, Math.ceil(adm.backlog / Math.max(adm.rate, 1) / 2));
          return reply
            .code(429)
            .header('Retry-After', String(retryAfter))
            .send({ error: 'busy', message: `The service is at capacity (about ${Math.round(adm.backlog / Math.max(adm.rate, 1))}s of work queued); retry shortly`, retry_after: retryAfter });
        }
        const old = await queues.interactive.getJob(docKey);
        if (old && (await old.isFailed())) await old.remove().catch(() => {});
        const snapshotAt = doc.snapshot_at || new Date().toISOString();
        rec = { doc_key: docKey, tenant_id: tenant, status: 'queued', type: doc.type, number: doc.data.number, document_id: doc.document_id ?? null, queued_at: new Date().toISOString() };
        await putDoc(rec);
        // jobId = content key: concurrent identical requests coalesce into one render.
        await queues.interactive.add('render', { kind: 'single', tenantId: tenant, docKey, snapshotAt, doc }, { jobId: docKey });
        enqueued = true;
      }

      const wait = Math.min(req.query.wait ?? config.sync.defaultWaitMs, config.sync.maxWaitMs);
      if (rec.status !== 'done' && wait > 0) {
        await waitForDoc(docKey, wait);
        rec = await getDoc(docKey);
      }
      const links = docLinks(rec, tenant);
      const elapsedMs = Date.now() - t0;

      if (rec.status === 'done') {
        if ((req.headers.accept || '').includes('application/pdf')) {
          reply.header('X-Doc-Key', docKey).header('X-Content-SHA256', rec.sha256).header('X-Signature', rec.signature).header('X-Elapsed-Ms', String(elapsedMs));
          return sendStoredFile(req, reply, { key: rec.storage_key, filename: pdfFilename(rec), contentType: 'application/pdf', etag: rec.sha256 });
        }
        return reply.code(200).send({ ...publicDoc(rec), cached: !enqueued, elapsed_ms: elapsedMs, ...links });
      }
      if (rec.status === 'failed') return reply.code(500).send({ ...publicDoc(rec), elapsed_ms: elapsedMs, ...links });
      return reply.code(202).header('Retry-After', '2').send({ ...publicDoc(rec), elapsed_ms: elapsedMs, ...links });
    },
  );

  const docAuth = keyOrToken((c, req) => c.d === req.params.docKey);

  app.get('/v1/documents/:docKey', { onRequest: docAuth }, async (req, reply) => {
    const rec = await getDoc(req.params.docKey);
    if (!rec || rec.tenant_id !== req.tenant) return reply.code(404).send({ error: 'not_found' });
    return { ...publicDoc(rec), ...docLinks(rec, req.tenant) };
  });

  // GET /v1/documents/:docKey/download?token=...&wait=5000
  // The link the ERP gives to the user's browser. If the PDF isn't ready yet
  // the request waits; a browser gets a tiny auto-refreshing page instead of
  // an error, an API client gets 202 + Retry-After.
  app.get('/v1/documents/:docKey/download', { onRequest: docAuth }, async (req, reply) => {
    let rec = await getDoc(req.params.docKey);
    if (!rec || rec.tenant_id !== req.tenant) return reply.code(404).send({ error: 'not_found' });
    const wait = Math.min(Number(req.query.wait ?? 5000), config.sync.maxWaitMs);
    if (rec.status !== 'done' && rec.status !== 'failed' && wait > 0) {
      await waitForDoc(rec.doc_key, wait);
      rec = await getDoc(req.params.docKey);
    }
    if (rec.status === 'done') {
      return sendStoredFile(req, reply, { key: rec.storage_key, filename: pdfFilename(rec), contentType: 'application/pdf', etag: rec.sha256, inline: req.query.inline === '1' });
    }
    if (rec.status === 'failed') return reply.code(500).send({ error: 'render_failed', message: rec.error });
    if ((req.headers.accept || '').includes('text/html')) {
      return reply
        .code(202)
        .header('Retry-After', '2')
        .type('text/html')
        .send(`<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2><title>Preparing your PDF…</title><body style="font:15px system-ui;display:grid;place-items:center;height:90vh;color:#334"><div>Preparing your PDF… this page will download it automatically.</div>`);
    }
    return reply.code(202).header('Retry-After', '2').send({ status: rec.status });
  });

  // ============================================================== bulk ===
  app.post('/v1/bulk', { onRequest: requireApiKey, schema: { body: bulkSchema } }, async (req, reply) => {
    const tenant = req.tenant;
    const { documents, callback_url, label } = req.body;
    const problems = [];
    documents.forEach((d, i) => {
      const p = reconcile(d);
      if (p.length) problems.push({ index: i, document_id: d.document_id, number: d.data.number, problems: p });
    });
    if (problems.length) return reply.code(422).send({ error: 'totals_mismatch', message: `${problems.length} document(s) do not reconcile; nothing was queued`, documents: problems });

    const active = await redis().scard(keys.tenantActive(tenant));
    if (active >= config.queue.maxActiveBulkPerTenant) {
      return reply.code(429).header('Retry-After', '30').send({ error: 'too_many_bulk_jobs', message: `At most ${config.queue.maxActiveBulkPerTenant} bulk jobs may run at once per account` });
    }

    const id = crypto.randomUUID();
    // The snapshot instant: every PDF in this batch says "Data as of" this time,
    // and is rendered ONLY from the payload persisted here — never re-read from
    // the ERP later. This is the fix for the stale-GST-invoice incident.
    const snapshotAt = req.body.snapshot_at || new Date().toISOString();
    const st = storage();
    const docKeys = documents.map((d) => documentKey(tenant, d));
    await Promise.all(documents.map((d, i) => st.putJson(`bulk/${id}/docs/${i}.json`, d)));
    await saveBulk({ id, tenant_id: tenant, label: label || null, status: 'queued', total: documents.length, snapshot_at: snapshotAt, created_at: new Date().toISOString(), callback_url: callback_url || null, generation: 1, parts: [] });
    const r = redis();
    const multi = r.multi();
    documents.forEach((d, i) =>
      multi.hset(keys.bulkItems(id), String(i), JSON.stringify({ index: i, doc_key: docKeys[i], document_id: d.document_id ?? null, type: d.type, number: d.data.number, rows: d.data.items.length, status: 'queued' })),
    );
    multi.expire(keys.bulkItems(id), 14 * 24 * 3600).sadd(keys.tenantActive(tenant), id);
    await multi.exec();
    await queues.bulk.addBulk(
      documents.map((d, i) => ({
        name: 'render',
        data: { kind: 'bulk', bulkId: id, index: i, tenantId: tenant, docKey: docKeys[i], snapshotAt, payloadKey: `bulk/${id}/docs/${i}.json` },
        opts: { jobId: `${id}-${i}-g1` },
      })),
    );
    const token = makeToken({ b: id, t: tenant });
    return reply.code(202).send({
      bulk_id: id,
      status: 'queued',
      total: documents.length,
      snapshot_at: snapshotAt,
      status_url: `${base}/v1/bulk/${id}?token=${token}`,
      events_url: `${base}/v1/bulk/${id}/events?token=${token}`,
      token,
    });
  });

  const bulkAuth = keyOrToken((c, req) => c.b === req.params.id);

  async function bulkView(id, tenant) {
    const bulk = await getBulk(id);
    if (!bulk || bulk.tenant_id !== tenant) return null;
    const items = await getBulkItems(id);
    const token = makeToken({ b: id, t: tenant });
    const startedMs = bulk.started_at ? Date.parse(bulk.started_at) : null;
    const elapsed = startedMs ? ((bulk.finished_at ? Date.parse(bulk.finished_at) : Date.now()) - startedMs) / 1000 : 0;
    const finished = bulk.done + bulk.failed;
    const rate = elapsed > 0 ? finished / elapsed : 0;
    const { callback_url, ...rest } = bulk;
    return {
      ...rest,
      progress: bulk.total ? Math.round((finished / bulk.total) * 100) : 0,
      eta_seconds: !FINAL_BULK.includes(bulk.status) && rate > 0 ? Math.ceil((bulk.total - finished) / rate) : null,
      elapsed_seconds: Math.round(elapsed),
      items: items.map((it) => ({ ...it, download_url: it.status === 'done' ? `${base}/v1/bulk/${id}/items/${it.index}?token=${token}` : undefined })),
      parts: (bulk.parts || []).map((p, i) => ({ name: p.name, bytes: p.bytes, sha256: p.sha256, files: p.files, url: `${base}/v1/bulk/${id}/parts/${i}?token=${token}` })),
      events_url: `${base}/v1/bulk/${id}/events?token=${token}`,
    };
  }

  app.get('/v1/bulk/:id', { onRequest: bulkAuth }, async (req, reply) => {
    const view = await bulkView(req.params.id, req.tenant);
    if (!view) return reply.code(404).send({ error: 'not_found' });
    return view;
  });

  // Server-Sent Events: progress pushed as it happens. EventSource reconnects
  // on its own after a network blip, and every (re)connect starts with a full
  // snapshot, so a client that missed events is never out of date.
  app.get('/v1/bulk/:id/events', { onRequest: bulkAuth }, async (req, reply) => {
    const view = await bulkView(req.params.id, req.tenant);
    if (!view) return reply.code(404).send({ error: 'not_found' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 2000\n\n');
    send('snapshot', view);
    const channel = keys.events(req.params.id);
    const onEvent = async (ev) => {
      send(ev.type, ev);
      if (ev.type === 'status' && FINAL_BULK.includes(ev.status)) send('snapshot', await bulkView(req.params.id, req.tenant));
    };
    hub.on(channel, onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(ping);
      hub.off(channel, onEvent);
    });
  });

  app.get('/v1/bulk/:id/parts/:n', { onRequest: bulkAuth }, async (req, reply) => {
    const bulk = await getBulk(req.params.id);
    if (!bulk || bulk.tenant_id !== req.tenant) return reply.code(404).send({ error: 'not_found' });
    const part = (bulk.parts || [])[Number(req.params.n)];
    if (!part) return reply.code(404).send({ error: 'not_ready', status: bulk.status });
    return sendStoredFile(req, reply, { key: part.key, filename: part.name, contentType: 'application/zip', etag: part.sha256 });
  });

  app.get('/v1/bulk/:id/items/:index', { onRequest: bulkAuth }, async (req, reply) => {
    const bulk = await getBulk(req.params.id);
    if (!bulk || bulk.tenant_id !== req.tenant) return reply.code(404).send({ error: 'not_found' });
    const raw = await redis().hget(keys.bulkItems(req.params.id), String(Number(req.params.index)));
    const item = raw && JSON.parse(raw);
    if (!item || item.status !== 'done') return reply.code(404).send({ error: 'not_ready' });
    const rec = await getDoc(item.doc_key);
    return sendStoredFile(req, reply, { key: rec.storage_key, filename: pdfFilename(rec), contentType: 'application/pdf', etag: rec.sha256, inline: req.query.inline === '1' });
  });

  app.post('/v1/bulk/:id/retry-failed', { onRequest: requireApiKey }, async (req, reply) => {
    const bulk = await getBulk(req.params.id);
    if (!bulk || bulk.tenant_id !== req.tenant) return reply.code(404).send({ error: 'not_found' });
    if (!FINAL_BULK.includes(bulk.status)) return reply.code(409).send({ error: 'still_running' });
    const failed = (await getBulkItems(bulk.id)).filter((i) => i.status === 'failed');
    if (!failed.length) return { retried: 0 };
    const gen = (bulk.generation || 1) + 1;
    await saveBulk({ ...bulk, generation: gen, status: 'running', parts: [], finished_at: null });
    const r = redis();
    for (const it of failed) {
      await r.srem(keys.bulkFailed(bulk.id), String(it.index));
      await setBulkItem(bulk.id, { ...it, status: 'queued', error: undefined });
      await putDoc({ ...((await getDoc(it.doc_key)) || {}), doc_key: it.doc_key, tenant_id: bulk.tenant_id, status: 'queued' });
    }
    await r.sadd(keys.tenantActive(bulk.tenant_id), bulk.id);
    await queues.bulk.addBulk(
      failed.map((it) => ({
        name: 'render',
        data: { kind: 'bulk', bulkId: bulk.id, index: it.index, tenantId: bulk.tenant_id, docKey: it.doc_key, snapshotAt: bulk.snapshot_at, payloadKey: `bulk/${bulk.id}/docs/${it.index}.json` },
        opts: { jobId: `${bulk.id}-${it.index}-g${gen}` },
      })),
    );
    return { retried: failed.length };
  });

  // ============================================================ verify ===
  // Public, no auth: anyone holding a PDF (an auditor, a customer) can check it.
  const verifyHits = new Map();
  // Forget IPs idle for a minute, so the map can't grow without bound.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [ip, arr] of verifyHits) if (arr[arr.length - 1] < cutoff) verifyHits.delete(ip);
  }, 60_000);
  sweep.unref();
  const rateLimited = (ip) => {
    const now = Date.now();
    const arr = (verifyHits.get(ip) || []).filter((t) => now - t < 60_000);
    arr.push(now);
    verifyHits.set(ip, arr);
    return arr.length > 30;
  };

  app.post('/v1/verify', async (req, reply) => {
    if (rateLimited(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'send the PDF as the request body with Content-Type: application/pdf' });
    const digest = sha256(body);
    const hit = (await lookupSha(digest)) || (await storage().getJson(`index/sha256/${digest}.json`).catch(() => null));
    if (hit) {
      const record = await storage().getJson(hit.record_key);
      const signatureValid = verifyRecordSignature(record);
      const ok = signatureValid && record.sha256 === digest;
      return {
        result: ok ? 'authentic' : 'invalid_signature',
        message: ok ? 'This file is byte-for-byte identical to the document we generated.' : 'A record exists but its signature does not verify.',
        sha256: digest,
        record: { ...record, tenant_id: undefined, storage_key: undefined },
      };
    }
    // Not an exact match. Did it claim to be one of ours? (ref is in the PDF title)
    let claimed = null;
    try {
      const pdf = await PDFDocument.load(body, { updateMetadata: false, ignoreEncryption: true });
      const m = /\[ref ([0-9a-f]{32})\]/.exec(pdf.getTitle() || '');
      if (m) claimed = m[1];
    } catch {
      /* not a parseable PDF */
    }
    if (claimed) {
      const rec = await getDoc(claimed); // may be gone from the 30-day cache for old documents
      return {
        result: 'modified',
        message: 'This file claims to be a document we generated, but its contents differ from what we issued. It has been altered.',
        sha256: digest,
        expected: rec?.status === 'done' ? { doc_key: rec.doc_key, type: rec.type, number: rec.number, sha256: rec.sha256, generated_at: rec.generated_at } : { doc_key: claimed },
      };
    }
    return { result: 'unknown', message: 'We have no record of generating this file.', sha256: digest };
  });

  app.get('/v1/verify/:docKey', async (req, reply) => {
    const rec = await getDoc(req.params.docKey);
    if (!rec || rec.status !== 'done') return reply.code(404).send({ error: 'not_found' });
    // Read the signed record from durable storage (the source of truth), not the Redis cache.
    const signed = await storage().getJson(rec.record_key);
    return {
      type: signed.type,
      title: `${TITLES[signed.type]} ${signed.number}`,
      number: signed.number,
      doc_key: signed.doc_key,
      sha256: signed.sha256,
      bytes: signed.bytes,
      pages: signed.pages,
      generated_at: signed.generated_at,
      snapshot_at: signed.snapshot_at,
      key_id: signed.key_id,
      signature: signed.signature,
      signature_valid: verifyRecordSignature(signed),
    };
  });

  app.get('/v1/keys', async () => publicKeyInfo());

  // ======================================================== operations ===
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await redis().ping();
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: err.message });
    }
  });
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(renderPrometheus(await collectStats(queues))));
  app.get('/v1/stats', { onRequest: config.demoMode ? [] : requireApiKey }, async () => collectStats(queues));

  // ============================================================== demo ===
  if (config.demoMode) {
    app.get('/demo/config', async () => ({ apiKey: config.auth.apiKeys[0]?.key, tenant: config.auth.apiKeys[0]?.tenant, heavyRowThreshold: config.render.heavyRowThreshold, maxBulk: config.queue.maxBulkDocuments }));
  }
  app.get('/lib/samples.js', async (_req, reply) => reply.type('text/javascript').sendFile('samples.js', path.join(config.root, 'src', 'lib')));
  await app.register(fastifyStatic, { root: path.join(config.root, 'public'), index: ['index.html'] });
  app.get('/verify', async (_req, reply) => reply.sendFile('verify.html'));

  app.addHook('onClose', async () => {
    await hub.close();
  });
  return app;
}

// Works on Windows too: compare file URLs, not hand-built strings.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await buildServer();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
