// Turns one validated document payload into a finished, stamped PDF.
//
// Large documents (hundreds of line items) are the OOM risk. Instead of handing
// Chromium one enormous DOM, we split the line items into chunks, print each
// chunk on a fresh page, and stitch the PDFs together with pdf-lib. Page
// numbers and the footer are stamped after merging so "Page 7 of 23" is right
// across chunk boundaries. Peak memory then depends on chunk size, not on the
// document size.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { renderHtml } from './templates.js';

const MM = 72 / 25.4;
// Page size and margins live in the template CSS (@page) so the footer margin
// boxes and the layout agree. tagged:false — Chromium's accessibility structure
// tree was ~60% of the file size for a 200-row PO (4,785 StructElem objects),
// see docs/benchmarks.md. Revisit if screen-reader accessibility is required.
export const PDF_OPTIONS = {
  printBackground: true,
  preferCSSPageSize: true,
  tagged: false,
  outline: false,
};

const TITLES = { invoice: 'Tax Invoice', purchase_order: 'Purchase Order' };

export function planChunks(items, chunkRows) {
  const total = items.length;
  const size = Math.max(1, chunkRows || total || 1);
  const chunks = [];
  for (let start = 0; start < Math.max(total, 1); start += size) {
    const rows = items.slice(start, start + size);
    chunks.push({ rows, from: start + 1, to: start + rows.length, total, isFirst: start === 0, isLast: start + size >= total });
  }
  return chunks;
}

// pdf-lib's standard fonts only speak WinAnsi; keep the footer ASCII-safe.
const ascii = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?');

const istFmt = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' IST';

/**
 * @param {BrowserPool} pool
 * @param {object} doc   validated payload
 * @param {object} meta  { docKey, snapshotAt, verifyUrl, generatedAt }
 * @param {object} opts  { chunkRows, timeoutMs }
 */
export async function renderDocument(pool, doc, meta, opts = {}) {
  const chunks = planChunks(doc.data.items || [], opts.chunkRows);
  if (chunks.length === 1) return renderSingle(pool, doc, meta, chunks[0], opts);
  return renderChunked(pool, doc, meta, chunks, opts);
}

// Escape a value for use inside a CSS string literal ("...").
const cssString = (s) => `"${String(s ?? '').replace(/[\\"\n\r<>]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

// Footer drawn by Chromium itself via CSS paged-media margin boxes
// (supported since Chromium 131). Unlike Puppeteer's footerTemplate, which
// prints every footer as a separate mini-document and re-embeds fonts on each
// page, margin boxes share the document's fonts.
function footerCss(doc, meta) {
  const box = 'font: 6.6pt "Noto Sans", sans-serif; color: #6b7380; vertical-align: top; padding-top: 2.5mm; border-top: 0.5px solid #d9dee5;';
  return `<style>@page {
    @bottom-left { content: ${cssString(footerLeft(doc, meta))}; ${box} }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} }
  }</style>`;
}

function footerLeft(doc, meta) {
  return `${TITLES[doc.type]} ${doc.data.number}  |  Data as of ${istFmt(meta.snapshotAt)}  |  Generated ${istFmt(meta.generatedAt)}  |  Ref ${meta.docKey.slice(0, 12)}`;
}

// Fast path (the vast majority of documents): one Chromium print, footer and
// page numbers drawn by Chromium, no post-processing. Profiling showed the
// pdf-lib load/save round trip alone cost ~60ms per PDF, about a quarter of
// the total, so we only pay it when we actually need to merge chunks.
async function renderSingle(pool, doc, meta, chunk, opts) {
  const t0 = performance.now();
  const html = (await renderHtml(doc, chunk, meta)).replace('</head>', `${footerCss(doc, meta)}</head>`);
  const buf = await pool.withPage(
    async (page) => {
      await page.setContent(html, { waitUntil: 'load', timeout: opts.timeoutMs });
      return page.pdf({ ...PDF_OPTIONS, timeout: opts.timeoutMs });
    },
    { timeoutMs: opts.timeoutMs },
  );
  const bytes = Buffer.from(buf);
  const ms = Math.round(performance.now() - t0);
  return { bytes, pages: countPages(bytes), chunks: 1, timings: { renderMs: ms, assembleMs: 0, totalMs: ms } };
}

// Chromium (Skia) writes page objects uncompressed, so this is reliable for
// its output; it is only used for reporting, never for correctness.
function countPages(bytes) {
  const m = bytes.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : null;
}

async function renderChunked(pool, doc, meta, chunks, opts) {
  const t0 = performance.now();
  const pdfs = [];
  for (const chunk of chunks) {
    const html = await renderHtml(doc, chunk, meta);
    // Each chunk gets a fresh page (and a fresh browser context), so the memory
    // of chunk N is released before chunk N+1 is laid out.
    const buf = await pool.withPage(
      async (page) => {
        await page.setContent(html, { waitUntil: 'load', timeout: opts.timeoutMs });
        return page.pdf({ ...PDF_OPTIONS, timeout: opts.timeoutMs });
      },
      { timeoutMs: opts.timeoutMs, fresh: true },
    );
    pdfs.push(buf);
  }
  const tRender = performance.now();

  const out = await PDFDocument.create();
  for (const buf of pdfs) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }

  const font = await out.embedFont(StandardFonts.Helvetica);
  const pages = out.getPages();
  const left = ascii(footerLeft(doc, meta));
  const grey = rgb(0.42, 0.45, 0.5);
  pages.forEach((page, i) => {
    const { width } = page.getSize();
    const y = 7 * MM;
    page.drawLine({ start: { x: 11 * MM, y: y + 9 }, end: { x: width - 11 * MM, y: y + 9 }, thickness: 0.4, color: rgb(0.85, 0.87, 0.9) });
    page.drawText(left, { x: 11 * MM, y, size: 6.6, font, color: grey });
    const right = `Page ${i + 1} of ${pages.length}`;
    page.drawText(right, { x: width - 11 * MM - font.widthOfTextAtSize(right, 6.6), y, size: 6.6, font, color: grey });
  });

  out.setTitle(`${TITLES[doc.type]} ${doc.data.number} [ref ${meta.docKey}]`);
  out.setSubject(`${doc.type} ${doc.document_id ?? ''}`.trim());
  out.setProducer('erp-pdf-service');
  out.setCreator(`erp-pdf-service template ${meta.templateVersion}`);
  out.setKeywords([`docKey:${meta.docKey}`, `snapshotAt:${meta.snapshotAt}`]);
  out.setCreationDate(new Date(meta.generatedAt));
  out.setModificationDate(new Date(meta.generatedAt));
  const bytes = await out.save();
  const tDone = performance.now();

  return {
    bytes: Buffer.from(bytes),
    pages: pages.length,
    chunks: chunks.length,
    timings: { renderMs: Math.round(tRender - t0), assembleMs: Math.round(tDone - tRender), totalMs: Math.round(tDone - t0) },
  };
}
