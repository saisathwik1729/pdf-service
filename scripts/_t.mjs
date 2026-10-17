import puppeteer from 'puppeteer';
import { renderHtml } from '../src/render/templates.js';
import { makePurchaseOrder } from '../src/lib/samples.js';
import fs from 'node:fs';
const b = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: 'shell', args: ['--no-sandbox'] });
const page = await b.newPage();
for (const rows of [5, 200, 1000]) {
  const doc = makePurchaseOrder({ rows, seed: rows });
  let html = await renderHtml(doc, { rows: doc.data.items, from: 1, to: rows, total: rows, isFirst: true, isLast: true }, { verifyUrl: 'http://x', docKey: 'abc' });
  const css = `<style>@page { size: A4; margin: 11mm 11mm 15mm 11mm;
    @bottom-left { content: "Purchase Order PO/1 | Data as of 16 Oct 2026 | Ref abc"; font: 6.6pt "Noto Sans", sans-serif; color: #6b7380; vertical-align: top; padding-top: 3mm; border-top: 0.5px solid #d9dee5; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 6.6pt "Noto Sans", sans-serif; color: #6b7380; vertical-align: top; padding-top: 3mm; border-top: 0.5px solid #d9dee5; } }</style>`;
  html = html.replace('</head>', css + '</head>');
  await page.setContent(html);
  const t = performance.now();
  const buf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  console.log(rows, 'rows', Math.round(buf.length/1024), 'KB', Math.round(performance.now()-t), 'ms');
  fs.writeFileSync(`/tmp/claude-0/out/noto${rows}.pdf`, buf);
}
await b.close();
