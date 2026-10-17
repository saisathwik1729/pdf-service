// Hashing, canonical JSON, Ed25519 signing of document records, and HMAC
// tokens for browser-facing download links.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Deterministic JSON: object keys sorted recursively. Used both for the
// content key (same data => same key) and for the bytes we sign.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Content key of a document: identical (tenant, type, data, template version)
 * => identical key. Used to deduplicate renders and coalesce concurrent
 * identical requests into one BullMQ job.
 */
export function documentKey(tenantId, doc) {
  return sha256(canonicalJson({ t: tenantId, type: doc.type, data: doc.data, tv: config.templateVersion })).slice(0, 32);
}

// ---------------------------------------------------------------- signing --

let keyPair = null;

function loadKeys() {
  if (keyPair) return keyPair;
  let privateKey;
  if (config.signing.privateKeyPem) {
    privateKey = crypto.createPrivateKey(config.signing.privateKeyPem.replace(/\\n/g, '\n'));
  } else {
    // Dev convenience: generate once and persist. In production the key comes
    // from AWS Secrets Manager / SSM (SecureString) via SIGNING_PRIVATE_KEY_PEM.
    const file = path.join(config.signing.keyDir, 'ed25519-private.pem');
    if (fs.existsSync(file)) {
      privateKey = crypto.createPrivateKey(fs.readFileSync(file));
    } else {
      fs.mkdirSync(config.signing.keyDir, { recursive: true });
      const kp = crypto.generateKeyPairSync('ed25519');
      try {
        fs.writeFileSync(file, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
        privateKey = kp.privateKey;
      } catch {
        // another process created it first; use theirs
        privateKey = crypto.createPrivateKey(fs.readFileSync(file));
      }
    }
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  keyPair = { privateKey, publicKey, publicPem, keyId };
  return keyPair;
}

export function publicKeyInfo() {
  const { publicPem, keyId } = loadKeys();
  return { alg: 'Ed25519', key_id: keyId, public_key_pem: publicPem };
}

/** Sign a document record. The signature covers canonicalJson(record without signature). */
export function signRecord(record) {
  const { privateKey, keyId } = loadKeys();
  const body = { ...record, key_id: keyId };
  delete body.signature;
  const signature = crypto.sign(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64url');
  return { ...body, signature };
}

export function verifyRecordSignature(record, publicKeyPem) {
  const pub = publicKeyPem ? crypto.createPublicKey(publicKeyPem) : loadKeys().publicKey;
  const { signature, ...body } = record;
  if (!signature) return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(body)), pub, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

// ------------------------------------------------------- download tokens --

// Compact HMAC token: base64url(json).base64url(hmac). Lets the ERP hand a
// link to an end user's browser without the browser ever holding an API key,
// and lets the browser talk to this service directly (no bytes through Django).
export function makeToken(claims, ttlSec = config.auth.downloadTokenTtlSec) {
  const body = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  const mac = crypto.createHmac('sha256', config.auth.downloadTokenSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', config.auth.downloadTokenSecret).update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!claims.exp || claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

export function hmacHex(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
