// HTML templating. Templates are compiled once at startup and rendered to a
// static HTML string server-side; Chromium only lays out and prints. JavaScript
// is disabled in the page, so nothing in a payload can execute.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import QRCode from 'qrcode';
import { amountInWordsINR } from '../lib/numwords.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');
const hb = Handlebars.create(); // isolated instance; {{ }} escapes HTML by default

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

hb.registerHelper('money', (v) => (v === undefined || v === null || v === '' ? '' : inr.format(Number(v))));
hb.registerHelper('qty', (v) => qty.format(Number(v || 0)));
hb.registerHelper('pct', (v) => (v === undefined || v === null ? '' : `${Number(v)}%`));
hb.registerHelper('add', (a, b) => Number(a) + Number(b));
hb.registerHelper('eq', (a, b) => a === b);
hb.registerHelper('gt', (a, b) => Number(a) > Number(b));
hb.registerHelper('date', (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
});
hb.registerHelper('initials', (name = '') =>
  String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join(''),
);
hb.registerHelper('words', (v) => amountInWordsINR(Number(v || 0)));
hb.registerHelper('lines', (v) => new hb.SafeString(hb.escapeExpression(v || '').replace(/\n/g, '<br>')));

const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
hb.registerPartial('items', fs.readFileSync(path.join(dir, 'partials-items.hbs'), 'utf8'));

const compiled = {
  invoice: hb.compile(fs.readFileSync(path.join(dir, 'invoice.hbs'), 'utf8'), { strict: false }),
  purchase_order: hb.compile(fs.readFileSync(path.join(dir, 'purchase_order.hbs'), 'utf8'), { strict: false }),
};

export const TEMPLATE_TYPES = Object.keys(compiled);

/**
 * Build the HTML for one chunk of a document.
 * @param {object} doc     validated payload (type, data, ...)
 * @param {object} chunk   { rows, from, to, total, isFirst, isLast }
 * @param {object} ctx     { docKey, verifyUrl, snapshotAt }
 */
export async function renderHtml(doc, chunk, ctx) {
  const tpl = compiled[doc.type];
  if (!tpl) throw new Error(`Unknown template type: ${doc.type}`);
  let qr = null;
  if (chunk.isLast && ctx.verifyUrl) {
    qr = await QRCode.toString(ctx.verifyUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  }
  const d = doc.data;
  const intra = (d.supply_type || 'intra') === 'intra';
  return tpl({
    css,
    ...d,
    type: doc.type,
    intra,
    chunk,
    ctx,
    qr: qr ? new hb.SafeString(qr) : null,
    taxSummary: chunk.isLast ? summariseTax(d.items, intra) : null,
  });
}

// Rate-wise tax breakup shown on the last page (what GST auditors look for).
function summariseTax(items, intra) {
  const byRate = new Map();
  for (const it of items) {
    const key = Number(it.tax_rate || 0);
    const cur = byRate.get(key) || { rate: key, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    cur.taxable += Number(it.taxable_value || 0);
    cur.cgst += Number(it.cgst || 0);
    cur.sgst += Number(it.sgst || 0);
    cur.igst += Number(it.igst || 0);
    byRate.set(key, cur);
  }
  return [...byRate.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((r) => ({ ...r, tax: intra ? r.cgst + r.sgst : r.igst }));
}
