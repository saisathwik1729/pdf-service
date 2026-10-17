// Document desk console. Talks to the service exactly like the ERP would:
// API key for creating work, signed links for everything a browser fetches.
import { makeInvoice, makePurchaseOrder } from './lib/samples.js';
import { resumableDownload, saveBlob } from './download.js';
import { verifyFile, renderVerdict } from './verify-lib.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtBytes = (b) => (b == null ? '–' : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtMs = (ms) => (ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const seed = () => Math.floor(Math.random() * 900000) + 1000;

let API_KEY = '';
let lastPdf = null; // { url, name }

async function api(path, body) {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify(body) });
}

// ================================================================ single ==
const PRESETS = {
  inv: () => makeInvoice({ rows: 9, seed: seed() * 3 }), // multiple of 3 -> intra-state buyer
  'inv-inter': () => makeInvoice({ rows: 14, seed: seed() * 3 + 1 }),
  po: () => makePurchaseOrder({ rows: 60, seed: seed() }),
  'po-heavy': () => makePurchaseOrder({ rows: 1200, seed: seed() }),
};
let preset = 'inv';
let payloadDirty = false;
let lastSent = null;

function freshPayload() {
  $('payload').value = JSON.stringify(PRESETS[preset](), null, 2);
  payloadDirty = false;
}

document.querySelectorAll('.preset').forEach((b) =>
  b.addEventListener('click', () => {
    preset = b.dataset.preset;
    document.querySelectorAll('.preset').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    freshPayload();
  }),
);
$('payload').addEventListener('input', () => (payloadDirty = true));

async function generate(doc) {
  const out = $('single-out');
  $('gen').disabled = true;
  $('again').disabled = true;
  out.innerHTML = '<p class="empty">Printing…</p>';
  const t0 = performance.now();
  try {
    const res = await api('v1/documents?wait=4500', doc);
    let body = await res.json();
    if (res.status === 422) {
      out.innerHTML = `<div class="msg err"><b>Refused: totals don't add up.</b> The service never prints a GST document whose totals disagree with its line items.<ul>${body.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
      return;
    }
    if (res.status === 429) {
      out.innerHTML = `<div class="msg err">${esc(body.message)}. Retry in ${res.headers.get('Retry-After')} s.</div>`;
      return;
    }
    if (!res.ok && res.status !== 202) {
      out.innerHTML = `<div class="msg err">${esc(body.message || body.error || `HTTP ${res.status}`)}</div>`;
      return;
    }
    while (body.status !== 'done' && body.status !== 'failed') {
      await new Promise((r) => setTimeout(r, 700));
      body = await (await fetch(body.status_url)).json();
    }
    const elapsed = performance.now() - t0;
    lastSent = doc;
    renderSingle(body, elapsed, doc);
  } catch (err) {
    out.innerHTML = `<div class="msg err">Could not reach the service: ${esc(err.message)}</div>`;
  } finally {
    $('gen').disabled = false;
    $('again').disabled = !lastSent;
  }
}

function renderSingle(r, elapsed, doc) {
  if (r.status === 'failed') {
    $('single-out').innerHTML = `<div class="msg err">Rendering failed after retries: ${esc(r.error)}</div>`;
    return;
  }
  const pct = Math.min(100, (elapsed / 5000) * 100);
  const how = r.cached
    ? 'Served from the archive: this exact data was printed before, so the same signed PDF is returned.'
    : r.chunks > 1
      ? `Printed in ${r.chunks} chunks of line items and stitched together, so memory stayed flat.`
      : 'Printed fresh.';
  lastPdf = { url: r.download_url, name: `${r.type === 'invoice' ? 'Invoice' : 'PO'}_${r.number}.pdf` };
  $('try-ok').disabled = false;
  $('try-bad').disabled = false;
  $('single-out').innerHTML = `
    <div class="budget">
      <div class="budget-head"><strong>${fmtMs(elapsed)}</strong><span>to a downloadable PDF, of a 5 s budget</span></div>
      <div class="track" aria-hidden="true"><div class="fill" style="width:0"></div><div class="limit"></div></div>
      <div class="ticks"><span>0</span><span>1 s</span><span>2 s</span><span>3 s</span><span>4 s</span><span>5 s</span></div>
    </div>
    <p style="font-size:14px">${esc(how)}</p>
    <dl class="facts">
      <dt>Document</dt><dd>${esc(r.number)}, ${doc.data.items.length.toLocaleString('en-IN')} lines</dd>
      <dt>Pages</dt><dd>${r.pages ?? '–'}</dd>
      <dt>Size</dt><dd>${fmtBytes(r.bytes)}</dd>
      <dt>Render time</dt><dd>${fmtMs(r.render_ms)}${r.attempt > 1 ? `, attempt ${r.attempt}` : ''}</dd>
      <dt>Data as of</dt><dd>${new Date(r.snapshot_at).toLocaleString('en-IN')}</dd>
      <dt>Fingerprint</dt><dd class="hash" title="SHA-256 of the file">${esc(r.sha256)}</dd>
    </dl>
    <div class="row" style="margin-bottom:12px">
      <a class="btn" href="${esc(r.download_url)}">Download PDF</a>
      <a class="btn quiet" href="${esc(r.verify_url)}" target="_blank" rel="noopener">Verification page</a>
    </div>
    <iframe class="preview" title="PDF preview" src="${esc(r.download_url)}&inline=1"></iframe>`;
  requestAnimationFrame(() => {
    const f = document.querySelector('.track .fill');
    if (f) f.style.width = `${pct}%`;
  });
}

$('gen').addEventListener('click', () => {
  if (!payloadDirty) freshPayload();
  let doc;
  try {
    doc = JSON.parse($('payload').value);
  } catch (e) {
    $('single-out').innerHTML = `<div class="msg err">The payload is not valid JSON: ${esc(e.message)}</div>`;
    return;
  }
  if ($('break').checked) {
    doc = structuredClone(doc);
    doc.data.totals.grand_total += 1000;
  }
  generate(doc).then(() => {
    if (!payloadDirty) freshPayload(); // next click prints a new document
  });
});
$('again').addEventListener('click', () => lastSent && generate(lastSent));

// ================================================================== bulk ==
const tray = $('tray');
let es = null;
let run = null; // { id, token, total, retried:Set, items:Map }

$('n').addEventListener('input', () => ($('n-out').value = $('n').value));

function buildDocs(n, heavy) {
  const base = seed() * 100;
  return Array.from({ length: n }, (_, i) => {
    if (heavy && i % 10 === 9) return makePurchaseOrder({ rows: 800, seed: base + i });
    return i % 3 === 1 ? makePurchaseOrder({ rows: 20 + (i % 7) * 6, seed: base + i }) : makeInvoice({ rows: 6 + (i % 9), seed: base + i });
  });
}

$('bulk-go').addEventListener('click', async () => {
  const n = Number($('n').value);
  const docs = buildDocs(n, $('heavy').checked);
  $('bulk-go').disabled = true;
  $('downloads').hidden = true;
  es?.close();
  try {
    const res = await api('v1/bulk', { label: $('label').value || undefined, documents: docs });
    const body = await res.json();
    if (res.status !== 202) {
      $('progress').innerHTML = `<span class="msg err">${esc(body.message || body.error)}</span>`;
      $('bulk-go').disabled = false;
      return;
    }
    run = { id: body.bulk_id, token: body.token, total: n, retried: new Set(), startedAt: performance.now(), items: new Map() };
    tray.innerHTML = '';
    docs.forEach((d, i) => {
      const s = document.createElement('button');
      s.className = `slip${d.data.items.length > 300 ? ' heavy' : ''}`;
      s.dataset.index = i;
      s.setAttribute('aria-label', `${d.type === 'invoice' ? 'Invoice' : 'Purchase order'} ${d.data.number}, waiting`);
      s.title = `${d.data.number} (${d.data.items.length} lines)`;
      s.innerHTML = '<span class="fold"></span>';
      s.addEventListener('click', () => {
        if (s.classList.contains('done')) window.open(`v1/bulk/${run.id}/items/${i}?token=${run.token}&inline=1`, '_blank', 'noopener');
      });
      tray.append(s);
    });
    $('snapshot-note').innerHTML = `Snapshot taken at <b>${fmtTime(body.snapshot_at)}</b>. All ${n} PDFs are printed from the data as it was at that moment, even if someone edits an invoice in the ERP while this runs.`;
    follow(body.events_url);
  } catch (err) {
    $('progress').innerHTML = `<span class="msg err">${esc(err.message)}</span>`;
    $('bulk-go').disabled = false;
  }
});

function setSlip(i, status, extra = {}) {
  const s = tray.children[i];
  if (!s) return;
  s.classList.remove('rendering', 'done', 'retrying', 'failed', 'queued');
  s.classList.add(status);
  if (extra.cached) s.classList.add('cached');
  if (status === 'retrying') run.retried.add(i);
  const label = s.getAttribute('aria-label').replace(/, \w+$/, '');
  s.setAttribute('aria-label', `${label}, ${status === 'done' ? 'ready' : status}`);
}

function follow(url) {
  // EventSource reconnects on its own; each (re)connect begins with a full snapshot.
  es = new EventSource(url);
  es.addEventListener('snapshot', (e) => {
    const v = JSON.parse(e.data);
    v.items.forEach((it) => setSlip(it.index, it.status, it));
    progress(v.done, v.failed, v.status);
    if (['done', 'partial', 'failed'].includes(v.status)) {
      es.close();
      $('bulk-go').disabled = false;
      showDownloads(v);
    }
  });
  es.addEventListener('item', (e) => {
    const d = JSON.parse(e.data);
    setSlip(d.index, d.status, d);
    if (d.done !== undefined) progress(d.done, d.failed, 'running');
  });
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    progress(d.done, d.failed, d.status);
  });
}

function progress(done, failed, status) {
  const total = run.total;
  const secs = (performance.now() - run.startedAt) / 1000;
  const finished = done + failed;
  const rate = finished / Math.max(secs, 0.001);
  const left = rate > 0 && finished < total ? Math.ceil((total - finished) / rate) : null;
  const words = { queued: 'Waiting for a worker', running: 'Printing', zipping: 'Packing the zip', done: 'Finished', partial: 'Finished with failures', failed: 'Failed' };
  $('progress').innerHTML = [
    `<span><b>${done}</b> of ${total} ready</span>`,
    failed ? `<span style="color:var(--bad)">${failed} failed</span>` : '',
    run.retried.size ? `<span style="color:var(--amber)">${run.retried.size} retried after a browser crash</span>` : '',
    `<span>${secs.toFixed(1)} s elapsed</span>`,
    left !== null ? `<span>about ${left} s left</span>` : '',
    `<span>${words[status] || status}</span>`,
  ].join('');
  $('bar').style.width = `${(finished / total) * 100}%`;
}

function showDownloads(v) {
  $('downloads').hidden = false;
  const parts = $('parts');
  parts.innerHTML = '';
  v.parts.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'part';
    row.innerHTML = `<div><div class="name">${esc(p.name)}</div><div class="meta">${fmtBytes(p.bytes)}, ${p.files} PDFs plus MANIFEST.json</div></div>
      <button class="btn">Download</button>
      <div class="bar"><div></div></div><div class="log"></div>`;
    const btn = row.querySelector('button');
    const fill = row.querySelector('.bar > div');
    const log = row.querySelector('.log');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      let drops = 0;
      log.textContent = 'Starting…';
      try {
        const { blob, bytes } = await resumableDownload(p.url, {
          expectedSha256: p.sha256,
          flaky: () => $('flaky').checked,
          onProgress: (got, total) => {
            fill.style.width = total ? `${(got / total) * 100}%` : '0';
            log.innerHTML = `${fmtBytes(got)} of ${fmtBytes(total)}${drops ? `, <span class="warn">${drops} drop${drops > 1 ? 's' : ''}, resumed each time from the last byte</span>` : ''}`;
          },
          onEvent: (ev) => {
            if (ev.type === 'retry') drops += 1;
          },
        });
        log.innerHTML = `<span class="ok">Checksum matches.</span> ${fmtBytes(bytes)} received${drops ? ` despite ${drops} dropped connection${drops > 1 ? 's' : ''}` : ''}. Saved.`;
        saveBlob(blob, p.name);
      } catch (err) {
        log.innerHTML = `<span style="color:var(--bad)">${esc(err.message)}</span>`;
      } finally {
        btn.disabled = false;
      }
    });
    parts.append(row);
  });
  if (!v.parts.length) parts.innerHTML = '<p class="msg err">No PDFs were produced, so there is nothing to download. Check the failed slips.</p>';
  const ok = v.items.filter((i) => i.status === 'done');
  $('files-sum').textContent = `Individual files (${ok.length})`;
  $('files').innerHTML = ok.map((it) => `<li><a href="${esc(it.download_url)}">${esc(it.number)}</a></li>`).join('');
  const firstDone = ok[0];
  if (firstDone) {
    lastPdf = { url: firstDone.download_url, name: `${firstDone.number}.pdf` };
    $('try-ok').disabled = false;
    $('try-bad').disabled = false;
  }
}

// ================================================================ verify ==
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add('over'))));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) check(f);
});
$('file').addEventListener('change', (e) => e.target.files[0] && check(e.target.files[0]));

async function check(blob) {
  $('verdict').innerHTML = '<p class="empty">Checking…</p>';
  try {
    renderVerdict($('verdict'), await verifyFile(blob));
  } catch (err) {
    $('verdict').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

async function lastPdfBytes() {
  return new Uint8Array(await (await fetch(lastPdf.url)).arrayBuffer());
}
$('try-ok').addEventListener('click', async () => check(new Blob([await lastPdfBytes()])));
$('try-bad').addEventListener('click', async () => {
  const bytes = await lastPdfBytes();
  // Change one character in the document's Producer field: a one-byte edit.
  const text = new TextDecoder('latin1').decode(bytes);
  let at = text.indexOf('/Producer');
  at = at >= 0 ? text.indexOf('(', at) + 1 : Math.floor(bytes.length / 2);
  bytes[at] = bytes[at] === 0x58 ? 0x59 : 0x58;
  check(new Blob([bytes]));
});

// ================================================================= stats ==
async function poll() {
  try {
    const s = await (await fetch('v1/stats')).json();
    const q = (c) => (c.waiting || 0) + (c.prioritized || 0) + (c.delayed || 0);
    $('s-queue').textContent = q(s.queues.interactive) + q(s.queues.bulk);
    $('s-rate').textContent = s.renders.last_minute;
    $('s-p50').innerHTML = s.renders.p50_ms == null ? '–' : `${fmtMs(s.renders.p50_ms)}<small>p95 ${fmtMs(s.renders.p95_ms)}</small>`;
    const known = s.workers.filter((w) => w.pool.memMb != null);
    const mem = known.reduce((a, w) => a + w.pool.memMb, 0);
    $('s-mem').innerHTML = !s.workers.length ? '<small>no worker</small>' : known.length ? `${mem}<small>MB</small>` : '–<small>measured on Linux only</small>';
    const crashes = s.workers.reduce((a, w) => a + (w.pool.crashes || 0), 0);
    const recycles = s.workers.reduce((a, w) => a + (w.pool.recycles || 0), 0);
    $('s-crash').innerHTML = `${crashes}<small>${recycles ? `+${recycles} planned` : ''}</small>`;
    $('live').classList.toggle('on', s.workers.length > 0);
    $('log').innerHTML = s.renders.recent
      .slice(0, 14)
      .map(
        (e) => `<tr><td>${new Date(e.at).toLocaleTimeString('en-IN', { hour12: false })}</td><td>${esc(e.kind)}</td><td class="n">${e.rows.toLocaleString('en-IN')}</td><td class="n">${e.pages ?? '–'}</td><td class="n">${fmtBytes(e.bytes)}</td><td class="n">${fmtMs(e.ms)}</td>
        <td>${e.chunks > 1 ? `<span class="tag heavy">${e.chunks} chunks</span> ` : ''}${e.attempt > 1 ? `<span class="tag retry">attempt ${e.attempt}</span>` : ''}</td></tr>`,
      )
      .join('') || '<tr><td colspan="7" class="empty">No renders yet.</td></tr>';
  } catch {
    $('live').classList.remove('on');
  }
}

// ================================================================== init ==
(async () => {
  try {
    API_KEY = (await (await fetch('demo/config')).json()).apiKey;
  } catch {
    $('single-out').innerHTML = '<div class="msg err">Demo mode is off on this server, so the console has no API key.</div>';
  }
  fetch('v1/keys')
    .then((r) => r.json())
    .then((k) => ($('key-id').textContent = `Ed25519 ${k.key_id}`))
    .catch(() => {});
  freshPayload();
  poll();
  setInterval(poll, 2000);
})();
