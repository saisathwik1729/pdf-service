// Central configuration. Every knob is an env var so the same image runs in
// dev (docker-compose), on a single EC2 box, or in ECS without code changes.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const int = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number.parseInt(v, 10);
};
const bool = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : ['1', 'true', 'yes'].includes(v.toLowerCase());
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 8080),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${int('PORT', 8080)}`,

  // Redis used ONLY by this service. It must run with maxmemory-policy=noeviction:
  // BullMQ keys must never be evicted. The ERP's existing cache Redis uses an LRU
  // policy, which is why we do not share it (see APPROACH.md, Decision 6).
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',

  auth: {
    // "tenant:key,tenant2:key2". The ERP monolith holds one key per tenant/env.
    apiKeys: (process.env.API_KEYS || 'demo:demo-key')
      .split(',')
      .filter(Boolean)
      .map((pair) => {
        const [tenant, key] = pair.split(':');
        return { tenant, key };
      }),
    // HMAC secret for short-lived download links handed to end users' browsers.
    downloadTokenSecret: process.env.DOWNLOAD_TOKEN_SECRET || 'dev-only-change-me',
    downloadTokenTtlSec: int('DOWNLOAD_TOKEN_TTL_SEC', 7 * 24 * 3600),
    // HMAC secret for webhook callbacks to the ERP.
    webhookSecret: process.env.WEBHOOK_SECRET || 'dev-webhook-secret',
  },

  demoMode: bool('DEMO_MODE', true),

  render: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // 'shell' = chrome-headless-shell (recommended). 'true' = new headless full Chrome.
    headless: process.env.PUPPETEER_HEADLESS || 'shell',
    // Page slots in the browser pool = max concurrent renders per worker process.
    poolSize: int('POOL_SIZE', Math.max(2, os.cpus().length)),
    // Slots bulk work may occupy; the rest are reserved for interactive requests
    // so a 100-PDF bulk job can never push single downloads past the 5s budget.
    bulkConcurrency: int('BULK_CONCURRENCY', Math.max(1, Math.floor(Math.max(2, os.cpus().length) / 2))),
    // Documents with more line items than this go to the "heavy lane":
    // rendered in chunks and only one at a time per worker.
    heavyRowThreshold: int('HEAVY_ROW_THRESHOLD', 300),
    chunkRows: int('CHUNK_ROWS', 250),
    minChunkRows: int('MIN_CHUNK_ROWS', 40),
    heavyConcurrency: int('HEAVY_CONCURRENCY', 1),
    renderTimeoutMs: int('RENDER_TIMEOUT_MS', 30000),
    // Browser hygiene: recycle Chromium periodically and when it grows too large.
    maxRendersPerBrowser: int('MAX_RENDERS_PER_BROWSER', 500),
    browserRssLimitMb: int('BROWSER_RSS_LIMIT_MB', 1200),
    maxLineItems: int('MAX_LINE_ITEMS', 5000),
  },

  queue: {
    interactiveName: 'pdf-interactive',
    bulkName: 'pdf-bulk',
    zipName: 'pdf-zip',
    attempts: int('JOB_ATTEMPTS', 3),
    // Admission control: refuse a single request (429 + Retry-After) when its
    // estimated queue wait (backlog / measured throughput) exceeds this budget.
    // A static backlog cap was tried first and failed under load (see APPROACH.md):
    // by the time 400 jobs were queued, accepted users were already waiting 20s.
    maxQueueWaitSec: int('MAX_QUEUE_WAIT_SEC', 4),
    minInteractiveBacklog: int('MIN_INTERACTIVE_BACKLOG', 40), // floor while throughput is unknown
    maxInteractiveBacklog: int('MAX_INTERACTIVE_BACKLOG', 2000), // absolute ceiling
    maxActiveBulkPerTenant: int('MAX_ACTIVE_BULK_PER_TENANT', 3),
    maxBulkDocuments: int('MAX_BULK_DOCUMENTS', 100),
  },

  sync: {
    // How long a "single" request may hold the HTTP connection waiting for the
    // render before falling back to 202 + poll. Leaves headroom inside 5s.
    defaultWaitMs: int('SINGLE_WAIT_MS', 4000),
    maxWaitMs: int('SINGLE_MAX_WAIT_MS', 25000),
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || 'local', // 'local' | 's3'
    localDir: process.env.STORAGE_DIR || path.join(ROOT, 'data', 'storage'),
    s3Bucket: process.env.S3_BUCKET || '',
    s3Region: process.env.AWS_REGION || 'ap-south-1',
    // Compliance retention for archived PDFs (S3 Object Lock, COMPLIANCE mode).
    // GST rules require books to be kept ~72 months after the annual return due
    // date; 8 years covers it with margin. Product/legal should confirm.
    retentionDays: int('ARCHIVE_RETENTION_DAYS', 8 * 365),
    zipPartMaxBytes: int('ZIP_PART_MAX_MB', 25) * 1024 * 1024,
  },

  signing: {
    privateKeyPem: process.env.SIGNING_PRIVATE_KEY_PEM || '',
    keyDir: process.env.SIGNING_KEY_DIR || path.join(ROOT, 'data', 'keys'),
  },

  templateVersion: '2026.10.1',
};
