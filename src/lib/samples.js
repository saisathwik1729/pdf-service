// Realistic sample payloads, shaped exactly like what the Django ERP sends.
// Used by the demo console, the benchmark, the load test and the tests.
// The ERP owns all money math; this generator mimics that so totals reconcile.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PRODUCTS = [
  ['MS Hex Bolt M12 x 60', '7318', 'pcs', 18, 18],
  ['SS 304 Sheet 2mm', '7219', 'kg', 245, 18],
  ['Bearing 6205 ZZ', '8482', 'pcs', 165, 18],
  ['Hydraulic Hose 1/2" (per m)', '4009', 'm', 310, 18],
  ['Industrial Gloves (pair)', '6116', 'pair', 42, 12],
  ['Cutting Oil 20L', '2710', 'can', 3150, 18],
  ['PVC Conduit 25mm', '3917', 'm', 38, 18],
  ['Copper Wire 2.5 sq mm', '8544', 'm', 29, 18],
  ['Welding Electrode E6013', '8311', 'kg', 210, 18],
  ['Corrugated Box 5-ply', '4819', 'pcs', 56, 12],
  ['V-Belt B-42', '4010', 'pcs', 285, 18],
  ['Safety Shoes', '6403', 'pair', 1150, 5],
  ['Machining service (per hr)', '998898', 'hr', 850, 18],
  ['Galvanised Pipe 1"', '7306', 'm', 182, 18],
  ['Rice Bran Oil 15L', '1515', 'tin', 2140, 5],
];

const round2 = (n) => Math.round(n * 100) / 100;

function lineItems(n, rand, { intra, po }) {
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const [name, hsn, unit, base, taxRate] = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
    const qty = Math.max(1, Math.round(rand() * 120));
    const rate = round2(base * (0.9 + rand() * 0.25));
    const discount = rand() < 0.3 ? [2, 5, 7.5, 10][Math.floor(rand() * 4)] : 0;
    const taxable = round2(qty * rate * (1 - discount / 100));
    const tax = round2((taxable * taxRate) / 100);
    const cgst = intra ? round2(tax / 2) : 0;
    const sgst = intra ? round2(tax - cgst) : 0;
    const igst = intra ? 0 : tax;
    const item = {
      description: name,
      item_code: `SKU-${hsn}-${String(i + 1).padStart(4, '0')}`,
      hsn,
      qty,
      unit,
      rate,
      discount_pct: discount,
      taxable_value: taxable,
      tax_rate: taxRate,
      cgst,
      sgst,
      igst,
      total: round2(taxable + cgst + sgst + igst),
    };
    if (po) item.delivery_date = new Date(Date.UTC(2026, 10, 1 + Math.floor(rand() * 40))).toISOString().slice(0, 10);
    items.push(item);
  }
  return items;
}

function totalsOf(items) {
  const t = items.reduce(
    (acc, it) => {
      acc.taxable += it.taxable_value;
      acc.cgst += it.cgst;
      acc.sgst += it.sgst;
      acc.igst += it.igst;
      return acc;
    },
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
  );
  for (const k of Object.keys(t)) t[k] = round2(t[k]);
  const raw = t.taxable + t.cgst + t.sgst + t.igst;
  const grand = Math.round(raw);
  return { ...t, round_off: round2(grand - raw), grand_total: grand };
}

const SELLER = {
  name: 'Narmada Industrial Supplies Pvt Ltd',
  address: 'Plot 42, Sector F, Sanwer Road Industrial Area\nIndore, Madhya Pradesh 452015',
  gstin: '23AABCN1234F1Z5',
  state: 'Madhya Pradesh',
  state_code: '23',
  phone: '+91 731 400 1234',
  email: 'accounts@narmadasupplies.example',
};

const BUYERS = [
  { name: 'Shree Ganesh Engineering Works', address: '17 Pologround Industrial Estate\nIndore, MP 452015', gstin: '23AAKFS9876M1Z2', state: 'Madhya Pradesh', state_code: '23' },
  { name: 'Vardhman Auto Components', address: 'Gat No. 112, Chakan MIDC\nPune, Maharashtra 410501', gstin: '27AACCV4567K1Z9', state: 'Maharashtra', state_code: '27' },
  { name: 'Coastal Packaging LLP', address: 'Survey 88, Vapi GIDC Phase 2\nVapi, Gujarat 396195', gstin: '24AAJFC2345L1Z3', state: 'Gujarat', state_code: '24' },
];

export function makeInvoice({ rows = 8, seed = 1, number } = {}) {
  const rand = rng(seed);
  const buyer = BUYERS[seed % BUYERS.length];
  const intra = buyer.state_code === SELLER.state_code;
  const items = lineItems(rows, rand, { intra, po: false });
  const n = number || `NIS/26-27/${String(1000 + seed).padStart(5, '0')}`;
  return {
    type: 'invoice',
    document_id: `inv_${seed}`,
    version: '2026-10-16T05:12:00Z',
    data: {
      number: n,
      date: '2026-10-16',
      due_date: '2026-11-15',
      po_reference: `PO-${4400 + seed}`,
      place_of_supply: `${buyer.state} (${buyer.state_code})`,
      supply_type: intra ? 'intra' : 'inter',
      reverse_charge: false,
      payment_terms: 'Net 30',
      seller: SELLER,
      buyer,
      items,
      totals: totalsOf(items),
      bank: { name: 'State Bank of India', account_name: SELLER.name, account_no: 'XXXXXXXX4521', ifsc: 'SBIN0001234', branch: 'Palasia, Indore' },
      notes: 'Goods once sold will be accepted back only if defective, within 7 days of delivery.',
      terms: '1. Interest @18% p.a. charged on payments delayed beyond the due date.\n2. Subject to Indore jurisdiction.',
    },
  };
}

export function makePurchaseOrder({ rows = 25, seed = 1, number } = {}) {
  const rand = rng(seed * 7 + 3);
  const vendor = { ...BUYERS[(seed + 1) % BUYERS.length], contact: 'Procurement desk · +91 98260 00000' };
  const intra = vendor.state_code === SELLER.state_code;
  const items = lineItems(rows, rand, { intra, po: true });
  return {
    type: 'purchase_order',
    document_id: `po_${seed}`,
    version: '2026-10-16T05:12:00Z',
    data: {
      number: number || `PO/26-27/${String(4400 + seed).padStart(5, '0')}`,
      date: '2026-10-16',
      expected_delivery: '2026-11-20',
      quotation_ref: `Q-${8800 + seed}`,
      payment_terms: '50% advance, balance on delivery',
      delivery_terms: 'FOR destination',
      supply_type: intra ? 'intra' : 'inter',
      buyer: SELLER,
      vendor,
      ship_to: { name: 'Narmada Industrial Supplies — Warehouse 2', address: 'Khasra 221, Dewas Naka\nIndore, MP 452010' },
      items,
      totals: totalsOf(items),
      approved_by: 'R. Sharma (Purchase Head)',
      terms: '1. Quote PO number on all invoices and delivery challans.\n2. Material subject to inspection at our stores.\n3. Test certificates required for all steel items.',
    },
  };
}
