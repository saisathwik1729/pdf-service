// Request schemas (enforced by Fastify/Ajv before handlers run) plus a
// business check: the PDF service never does tax math, but it refuses to print
// a document whose totals don't reconcile with its own line items. A wrong
// GST invoice is worse than a failed one.
import { config } from '../config.js';

const str = (max = 200) => ({ type: 'string', maxLength: max });
const num = { type: 'number' };
const GSTIN = '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';

const party = {
  type: 'object',
  required: ['name'],
  properties: {
    name: str(200),
    address: str(600),
    gstin: { type: 'string', pattern: GSTIN },
    state: str(60),
    state_code: { type: 'string', pattern: '^[0-9]{2}$' },
    phone: str(40),
    email: str(120),
    contact: str(120),
  },
};

const item = {
  type: 'object',
  required: ['description', 'qty', 'rate', 'taxable_value', 'tax_rate', 'total'],
  properties: {
    description: str(300),
    item_code: str(60),
    hsn: { type: 'string', pattern: '^[0-9]{4,8}$' },
    qty: num,
    unit: str(20),
    rate: num,
    discount_pct: { type: 'number', minimum: 0, maximum: 100 },
    taxable_value: num,
    tax_rate: { type: 'number', minimum: 0, maximum: 40 },
    cgst: num,
    sgst: num,
    igst: num,
    total: num,
    delivery_date: str(30),
  },
};

const totals = {
  type: 'object',
  required: ['taxable', 'grand_total'],
  properties: { taxable: num, cgst: num, sgst: num, igst: num, round_off: num, grand_total: num },
};

const common = {
  number: str(60),
  date: str(30),
  supply_type: { type: 'string', enum: ['intra', 'inter'] },
  items: { type: 'array', minItems: 1, maxItems: config.render.maxLineItems, items: item },
  totals,
  ship_to: party,
  notes: str(2000),
  terms: str(4000),
  payment_terms: str(200),
};

export const documentSchema = {
  type: 'object',
  required: ['type', 'data'],
  properties: {
    type: { type: 'string', enum: ['invoice', 'purchase_order'] },
    document_id: str(100), // ERP primary key, echoed back
    version: str(60), // ERP row version / updated_at at snapshot time
    snapshot_at: { type: 'string', format: 'date-time' },
    data: { type: 'object' },
  },
  allOf: [
    {
      if: { properties: { type: { const: 'invoice' } } },
      then: {
        properties: {
          data: {
            type: 'object',
            required: ['number', 'date', 'seller', 'buyer', 'items', 'totals'],
            properties: {
              ...common,
              due_date: str(30),
              po_reference: str(60),
              place_of_supply: str(80),
              reverse_charge: { type: 'boolean' },
              seller: party,
              buyer: party,
              einvoice: { type: 'object', properties: { irn: str(80), ack_no: str(40), ack_date: str(40) } },
              bank: { type: 'object', properties: { name: str(100), account_name: str(200), account_no: str(40), ifsc: str(20), branch: str(100) } },
            },
          },
        },
      },
    },
    {
      if: { properties: { type: { const: 'purchase_order' } } },
      then: {
        properties: {
          data: {
            type: 'object',
            required: ['number', 'date', 'buyer', 'vendor', 'items', 'totals'],
            properties: {
              ...common,
              expected_delivery: str(30),
              quotation_ref: str(60),
              delivery_terms: str(200),
              approved_by: str(120),
              buyer: party,
              vendor: party,
            },
          },
        },
      },
    },
  ],
};

export const bulkSchema = {
  type: 'object',
  required: ['documents'],
  properties: {
    snapshot_at: { type: 'string', format: 'date-time' },
    callback_url: { type: 'string', format: 'uri', maxLength: 500 },
    label: str(120),
    documents: { type: 'array', minItems: 1, maxItems: config.queue.maxBulkDocuments, items: documentSchema },
  },
};

const TOL = 0.05; // paise-level rounding tolerance

/** @returns {string[]} reconciliation problems (empty = ok) */
export function reconcile(doc) {
  const problems = [];
  const { items, totals: t } = doc.data;
  const sum = (k) => items.reduce((a, it) => a + Number(it[k] || 0), 0);
  const close = (a, b) => Math.abs(a - b) <= TOL;
  items.forEach((it, i) => {
    const tax = Number(it.cgst || 0) + Number(it.sgst || 0) + Number(it.igst || 0);
    if (!close(Number(it.taxable_value) + tax, Number(it.total))) problems.push(`items[${i}]: taxable_value + taxes != total`);
  });
  if (problems.length > 5) return [...problems.slice(0, 5), `…and ${problems.length - 5} more line items`];
  if (!close(sum('taxable_value'), t.taxable)) problems.push(`totals.taxable ${t.taxable} != sum of line taxable values ${sum('taxable_value').toFixed(2)}`);
  for (const k of ['cgst', 'sgst', 'igst']) {
    if (t[k] !== undefined && !close(sum(k), t[k])) problems.push(`totals.${k} ${t[k]} != sum of lines ${sum(k).toFixed(2)}`);
  }
  const grand = Number(t.taxable) + Number(t.cgst || 0) + Number(t.sgst || 0) + Number(t.igst || 0) + Number(t.round_off || 0);
  if (!close(grand, t.grand_total)) problems.push(`totals.grand_total ${t.grand_total} != taxable + taxes + round_off (${grand.toFixed(2)})`);
  const intra = (doc.data.supply_type || 'intra') === 'intra';
  if (intra && sum('igst') > 0) problems.push('supply_type is intra-state but IGST is charged');
  if (!intra && sum('cgst') + sum('sgst') > 0) problems.push('supply_type is inter-state but CGST/SGST is charged');
  return problems;
}
