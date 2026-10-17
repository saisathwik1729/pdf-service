// Object storage behind one small interface.
//   local: files under STORAGE_DIR (dev, tests, single-box deployments)
//   s3   : one bucket with Object Lock enabled (production)
//
// Key layout
//   archive/<tenant>/<yyyy>/<mm>/<docKey>.pdf    the PDF (compliance copy, locked)
//   archive/<tenant>/<yyyy>/<mm>/<docKey>.json   signed record (locked)
//   bulk/<bulkId>/docs/<index>.json              snapshot payloads (expire 7d)
//   bulk/<bulkId>/<name>.zip                     zip parts (expire 7d)
//
// There is deliberately only ONE copy of each PDF: the archive object is also
// what users download. Object Lock (COMPLIANCE mode) makes it immutable for the
// retention period, which is the storage half of tamper evidence.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

class LocalStorage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  #p(key) {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('invalid key');
    return full;
  }

  async put(key, body, { retain = false } = {}) {
    const file = this.#p(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file); // atomic: readers never see half a file
    // Local stand-in for Object Lock: read-only file. (Real immutability = S3.)
    if (retain) await fsp.chmod(file, 0o444).catch(() => {});
  }

  async putJson(key, obj, opts) {
    await this.put(key, Buffer.from(JSON.stringify(obj, null, 2)), opts);
  }

  async getBuffer(key) {
    return fsp.readFile(this.#p(key));
  }

  async getJson(key) {
    return JSON.parse(await fsp.readFile(this.#p(key), 'utf8'));
  }

  async stat(key) {
    try {
      const s = await fsp.stat(this.#p(key));
      return { size: s.size, mtime: s.mtime };
    } catch {
      return null;
    }
  }

  createReadStream(key, range) {
    return fs.createReadStream(this.#p(key), range);
  }

  // Local driver serves bytes itself (with Range support) — no redirect.
  async presignGet() {
    return null;
  }
}

class S3Storage {
  constructor({ bucket, region }) {
    this.bucket = bucket;
    this.ready = (async () => {
      const s3 = await import('@aws-sdk/client-s3');
      const presign = await import('@aws-sdk/s3-request-presigner');
      this.s3 = s3;
      this.client = new s3.S3Client({ region });
      this.getSignedUrl = presign.getSignedUrl;
    })();
  }

  async put(key, body, { retain = false, contentType } = {}) {
    await this.ready;
    const params = {
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType || (key.endsWith('.pdf') ? 'application/pdf' : key.endsWith('.zip') ? 'application/zip' : 'application/json'),
      ChecksumAlgorithm: 'SHA256', // S3 verifies the upload end to end
    };
    if (retain) {
      params.ObjectLockMode = 'COMPLIANCE';
      params.ObjectLockRetainUntilDate = new Date(Date.now() + config.storage.retentionDays * 86400_000);
    }
    await this.client.send(new this.s3.PutObjectCommand(params));
  }

  async putJson(key, obj, opts) {
    await this.put(key, Buffer.from(JSON.stringify(obj, null, 2)), { ...opts, contentType: 'application/json' });
  }

  async getBuffer(key) {
    await this.ready;
    const res = await this.client.send(new this.s3.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async getJson(key) {
    return JSON.parse((await this.getBuffer(key)).toString('utf8'));
  }

  async stat(key) {
    await this.ready;
    try {
      const r = await this.client.send(new this.s3.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength, mtime: r.LastModified };
    } catch {
      return null;
    }
  }

  // Browsers download straight from S3 (Range requests and resume are
  // handled by S3); the service only issues a short-lived signed URL.
  async presignGet(key, { filename, ttlSec = 3600 } = {}) {
    await this.ready;
    const cmd = new this.s3.GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/"/g, '')}"` : undefined,
    });
    return this.getSignedUrl(this.client, cmd, { expiresIn: ttlSec });
  }
}

let instance;
export function storage() {
  if (!instance) {
    instance =
      config.storage.driver === 's3'
        ? new S3Storage({ bucket: config.storage.s3Bucket, region: config.storage.s3Region })
        : new LocalStorage(config.storage.localDir);
  }
  return instance;
}

export function archiveKey(tenantId, docKey, generatedAt) {
  const d = new Date(generatedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const safeTenant = String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `archive/${safeTenant}/${yyyy}/${mm}/${docKey}`;
}
