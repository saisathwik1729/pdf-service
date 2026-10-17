// Serving stored files to flaky clients.
// S3 driver: 302 to a short-lived presigned URL (S3 does Range/resume natively).
// Local driver: we implement Range ourselves: 206 partial content, If-Range,
// ETag, so an interrupted download resumes instead of restarting.
import { storage } from '../storage/index.js';

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    // suffix range: last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

const asciiFilename = (s) => String(s).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');

export async function sendStoredFile(req, reply, { key, filename, contentType, etag, inline = false }) {
  const st = storage();
  const signed = await st.presignGet(key, { filename });
  if (signed) return reply.redirect(signed, 302);

  const stat = await st.stat(key);
  if (!stat) return reply.code(404).send({ error: 'not_found' });
  const tag = `"${etag || `${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}`}"`;

  reply
    .header('Accept-Ranges', 'bytes')
    .header('ETag', tag)
    .header('Last-Modified', stat.mtime.toUTCString())
    .header('Cache-Control', 'private, max-age=86400, immutable')
    .header('Content-Type', contentType)
    .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(filename)}"`);

  if (req.headers['if-none-match'] === tag) return reply.code(304).send();

  let range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
  // If-Range: only honour the Range if the client's copy is still current.
  if (range && req.headers['if-range'] && req.headers['if-range'] !== tag) range = null;
  if (range === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
  }
  if (range) {
    reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`).header('Content-Length', range.end - range.start + 1);
    if (req.method === 'HEAD') return reply.send();
    return reply.send(st.createReadStream(key, { start: range.start, end: range.end }));
  }
  reply.header('Content-Length', stat.size);
  if (req.method === 'HEAD') return reply.send();
  return reply.send(st.createReadStream(key));
}

export { parseRange };
