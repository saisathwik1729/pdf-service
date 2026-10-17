// Resumable download over HTTP Range requests.
// The file is fetched in 1 MB ranges. If a request dies part-way through, the
// bytes already received are kept and the next request starts from exactly
// there (If-Range guards against the file having changed underneath us).
// When everything has arrived, the SHA-256 is checked before saving.

export async function resumableDownload(url, { expectedSha256, chunkSize = 1 << 20, flaky = () => false, onProgress = () => {}, onEvent = () => {}, maxRetries = 40 } = {}) {
  const pieces = [];
  let received = 0;
  let total = null;
  let etag = null;
  let retries = 0;

  while (total === null || received < total) {
    const end = total === null ? received + chunkSize - 1 : Math.min(received + chunkSize, total) - 1;
    const ctrl = new AbortController();
    // Simulated bad network: some requests are cut off after a random number of bytes.
    const dropAfter = flaky() && Math.random() < 0.35 ? Math.floor(Math.random() * chunkSize * 0.9) : null;
    try {
      const headers = { Range: `bytes=${received}-${end}` };
      if (etag) headers['If-Range'] = etag;
      const res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
      if (res.status === 200) {
        // Server ignored our Range (e.g. the file changed): start again cleanly.
        if (received > 0) onEvent({ type: 'restart' });
        pieces.length = 0;
        received = 0;
        total = Number(res.headers.get('Content-Length')) || null;
      } else if (res.status === 206) {
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get('Content-Range') || '');
        if (!m || Number(m[1]) !== received) throw new Error('unexpected Content-Range');
        total = Number(m[3]);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
      etag = res.headers.get('ETag') || etag;

      const reader = res.body.getReader();
      let thisRequest = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let chunk = value;
        if (dropAfter !== null && thisRequest + chunk.length > dropAfter) {
          chunk = chunk.subarray(0, Math.max(0, dropAfter - thisRequest));
          if (chunk.length) {
            pieces.push(chunk);
            received += chunk.length;
          }
          ctrl.abort();
          throw new Error('connection dropped');
        }
        pieces.push(chunk);
        received += chunk.length;
        thisRequest += chunk.length;
        onProgress(received, total);
      }
      retries = 0;
    } catch (err) {
      retries += 1;
      onProgress(received, total);
      onEvent({ type: 'retry', at: received, total, error: err.message, retries });
      if (retries > maxRetries) throw new Error(`gave up after ${maxRetries} retries: ${err.message}`);
      const wait = Math.min(4000, 250 * 2 ** Math.min(retries, 4)) * (0.6 + Math.random() * 0.8);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const blob = new Blob(pieces);
  let shaOk = null;
  if (expectedSha256 && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    shaOk = hex === expectedSha256;
    if (!shaOk) throw new Error('checksum mismatch: the downloaded file is corrupt');
  }
  return { blob, bytes: received, shaOk };
}

export function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}
