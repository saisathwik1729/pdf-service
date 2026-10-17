// Shared by the console and the public /verify page.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TYPES = { invoice: 'Tax invoice', purchase_order: 'Purchase order' };
const STAMP = { authentic: 'Authentic', modified: 'Altered', unknown: 'Not issued by us', invalid_signature: 'Bad signature' };

export async function verifyFile(blob) {
  if (blob.size > 25 * 1024 * 1024) throw new Error('That file is larger than 25 MB, which is bigger than any document this service produces.');
  const res = await fetch('v1/verify', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: blob });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

export function renderVerdict(el, v) {
  const r = v.record;
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  let detail = `<p>${esc(v.message)}</p>`;
  if (v.result === 'authentic' && r) {
    detail += `<dl class="facts"><dt>Document</dt><dd>${esc(TYPES[r.type])} ${esc(r.number)}</dd><dt>Generated</dt><dd>${when(r.generated_at)}</dd><dt>Data as of</dt><dd>${when(r.snapshot_at)}</dd><dt>Signed by key</dt><dd class="hash">${esc(r.key_id)}</dd><dt>Fingerprint</dt><dd class="hash">${esc(v.sha256)}</dd></dl>`;
  } else if (v.result === 'modified' && v.expected) {
    detail += `<dl class="facts"><dt>Claims to be</dt><dd>${esc(TYPES[v.expected.type] || 'Document')} ${esc(v.expected.number || v.expected.doc_key)}</dd><dt>Issued fingerprint</dt><dd class="hash">${esc(v.expected.sha256 || '–')}</dd><dt>This file</dt><dd class="hash">${esc(v.sha256)}</dd></dl>`;
  } else {
    detail += `<dl class="facts"><dt>Fingerprint</dt><dd class="hash">${esc(v.sha256)}</dd></dl>`;
  }
  el.innerHTML = `<div class="verdict"><div class="stamp pop ${esc(v.result)}" role="status">${STAMP[v.result] || esc(v.result)}</div><div>${detail}</div></div>`;
}
