// Queues, Redis connections and the small amount of state we keep in Redis.
//
// Three queues, deliberately separate:
//   pdf-interactive : single-document requests. A user is waiting (5s budget).
//   pdf-bulk        : one job per document of a bulk request. Throughput work.
//   pdf-zip         : assembles zip parts once a bulk request is finished.
// Workers reserve render slots for interactive work so bulk can never starve it.
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

let lastRedisWarning = 0;
export function redisConnection(extra = {}) {
  const conn = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true, ...extra });
  // ioredis retries forever by design (queued work must survive a Redis restart),
  // so say clearly what's wrong instead of hanging silently.
  conn.on('error', (err) => {
    if (Date.now() - lastRedisWarning < 10_000) return;
    lastRedisWarning = Date.now();
    console.error(`[redis] cannot connect to ${config.redisUrl.replace(/:[^:@/]*@/, ':***@')} (${err.code || err.message}). Is Redis running? Set REDIS_URL if it uses another host/port. Retrying...`);
  });
  return conn;
}

let shared;
export function redis() {
  if (!shared) shared = redisConnection();
  return shared;
}

const defaultJobOptions = {
  attempts: config.queue.attempts,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 24 * 3600 },
};

let queues;
export function getQueues() {
  if (!queues) {
    const connection = redis();
    queues = {
      interactive: new Queue(config.queue.interactiveName, { connection, defaultJobOptions }),
      bulk: new Queue(config.queue.bulkName, { connection, defaultJobOptions }),
      zip: new Queue(config.queue.zipName, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 5 } }),
    };
  }
  return queues;
}

let interactiveEvents;
export function getInteractiveEvents() {
  if (!interactiveEvents) interactiveEvents = new QueueEvents(config.queue.interactiveName, { connection: redisConnection() });
  return interactiveEvents;
}

// ------------------------------------------------------------- records ----
// Document records: what was rendered, where it is, its hash and signature.
// Redis is the hot index; the signed record is also written next to the PDF in
// object storage, which is the durable source of truth.
const DOC_TTL = 30 * 24 * 3600;
const K = {
  doc: (key) => `pdfsvc:doc:${key}`,
  sha: (sha) => `pdfsvc:sha:${sha}`,
  bulk: (id) => `pdfsvc:bulk:${id}`,
  bulkItems: (id) => `pdfsvc:bulk:${id}:items`,
  bulkDone: (id) => `pdfsvc:bulk:${id}:done`, // SETs of indexes: idempotent counting
  bulkFailed: (id) => `pdfsvc:bulk:${id}:failed`, // even if a job is retried after a crash
  docEvents: (key) => `pdfsvc:events:doc:${key}`,
  tenantActive: (t) => `pdfsvc:tenant:${t}:active-bulk`,
  events: (id) => `pdfsvc:events:bulk:${id}`,
  worker: (id) => `pdfsvc:worker:${id}`,
  renderLog: 'pdfsvc:render-log',
  rate: (kind, sec) => `pdfsvc:rate:${kind}:${sec}`, // per-second completion counters
};
export const keys = K;

export async function getDoc(docKey) {
  const raw = await redis().get(K.doc(docKey));
  return raw ? JSON.parse(raw) : null;
}

export async function putDoc(record) {
  const r = redis();
  const multi = r.multi().set(K.doc(record.doc_key), JSON.stringify(record), 'EX', DOC_TTL);
  // sha256 -> signed record: a 30-day hot cache only. The durable index is an
  // object in storage (index/sha256/<sha>.json), written by the worker. An
  // earlier version kept this in Redis forever; capacity math showed ~0.6GB
  // after 8 years of retention, in a noeviction Redis that also holds the queues.
  if (record.sha256 && record.record_key) {
    multi.set(K.sha(record.sha256), JSON.stringify({ doc_key: record.doc_key, record_key: record.record_key }), 'EX', DOC_TTL);
  }
  await multi.exec();
}

export async function lookupSha(sha) {
  const raw = await redis().get(K.sha(sha));
  return raw ? JSON.parse(raw) : null;
}

export async function publishDocEvent(docKey, event) {
  await redis().publish(K.docEvents(docKey), JSON.stringify(event));
}

export async function getBulk(id) {
  const r = redis();
  const [raw, done, failed] = await Promise.all([r.get(K.bulk(id)), r.scard(K.bulkDone(id)), r.scard(K.bulkFailed(id))]);
  if (!raw) return null;
  const bulk = JSON.parse(raw);
  bulk.done = done;
  bulk.failed = failed;
  return bulk;
}

export async function saveBulk(bulk) {
  const { done, failed, ...rest } = bulk;
  await redis().set(K.bulk(bulk.id), JSON.stringify(rest), 'EX', 14 * 24 * 3600);
}

export async function getBulkItems(id) {
  const all = await redis().hgetall(K.bulkItems(id));
  return Object.values(all)
    .map((v) => JSON.parse(v))
    .sort((a, b) => a.index - b.index);
}

export async function setBulkItem(id, item) {
  await redis().hset(K.bulkItems(id), String(item.index), JSON.stringify(item));
}

export async function publishBulkEvent(id, event) {
  await redis().publish(K.events(id), JSON.stringify(event));
}

// Rolling log of render durations for /metrics and the console (last 2000).
export async function logRender(entry) {
  const sec = Math.floor(Date.now() / 1000);
  await redis()
    .multi()
    .lpush(K.renderLog, JSON.stringify(entry))
    .ltrim(K.renderLog, 0, 1999)
    .incr(K.rate(entry.kind, sec))
    .expire(K.rate(entry.kind, sec), 120)
    .exec();
}

/** Completed renders per second of `kind` over the last `windowSec` seconds (all workers). */
export async function recentRate(kind, windowSec = 10) {
  const now = Math.floor(Date.now() / 1000);
  // exclude the current, still-filling second
  const ks = Array.from({ length: windowSec }, (_, i) => K.rate(kind, now - 1 - i));
  const vals = await redis().mget(ks);
  return vals.reduce((a, v) => a + Number(v || 0), 0) / windowSec;
}
