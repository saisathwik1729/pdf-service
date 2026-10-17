# Benchmarks and load tests

Everything here was measured, not estimated. Raw output is in the JSON files next
to this document; re-run with `npm run bench` and `npm run loadtest`.

**Machine:** 2 vCPU Intel Xeon @ 2.10 GHz, 8 GB RAM (cloud sandbox, not AWS).
That is the same vCPU count as the proposed `c7i.large`. Treat absolute numbers
as ±30% for a different CPU; the *ratios* are what drove the design.

**Memory metric:** Chromium is many processes. v2 numbers are the summed **PSS**
of the whole process tree. v0 used summed RSS, which double-counts shared
libraries, so v0 memory figures are inflated and not directly comparable.

## How the renderer evolved

Each row is the same benchmark (`scripts/bench.js`) after one change.

| Version | Change | 12-line invoice, 1 stream | Throughput @ 4 concurrent | Invoice size |
|---|---|---|---|---|
| v0 | Full Chrome, new browser context per PDF, pdf-lib stamps the footer | ~320 ms p50 | **4.9 PDF/s** | 118 KB |
| v1 | `chrome-headless-shell`, warm reused pages, Puppeteer `footerTemplate` | 71 ms p50 | 17.9 PDF/s | **255 KB** (4,000 lines: **15.5 MB**) |
| v2 (final) | CSS `@page` margin-box footer, `tagged: false`, Noto Sans TTF | **48 ms p50** | **33 PDF/s** | **87 KB** |

What each step taught:

* **Profiling v0** (per stage, 30 renders): opening a new tab cost 96 ms, printing
  84 ms, pdf-lib re-assembly 65 ms, closing the context 25 ms. Rendering the
  HTML itself: 5 ms. The expensive parts were all overhead around the render.
* **Headless shell vs full Chrome:** same Chromium version, 40% less time per
  PDF (no browser UI code). Opening a page dropped from 96 ms to 37 ms; reusing
  warm pages removes it entirely for normal documents.
* **v1's file sizes exploded.** Two independent causes, found by inspecting the
  PDF objects rather than guessing:
  1. Chromium now emits *tagged* (accessibility) PDFs by default:
     4,785 `StructElem` objects = 489 KB of an 827 KB 200-line PO. The v0
     pipeline had silently dropped them in pdf-lib, which is why v0 looked fine.
  2. The Inter font we started with is OpenType-CFF; Skia embeds that as
     **Type 3** glyph procedures, repeated many times. TrueType fonts embed as
     proper subset CID fonts. Switched to pinned Noto Sans TTF (also covers ₹).
* `footerTemplate` was replaced anyway: CSS paged-media margin boxes
  (Chromium ≥ 131) draw "Page X of Y" inside the main document, so no second
  print pass and no per-page font copies.

## Final numbers (v2)

### Cold start vs warm pool (12-line invoice)

| | p50 | p95 | Peak memory |
|---|---|---|---|
| Launch Chromium per PDF (the brief's model) | 252 ms | 374 ms | 177 MB |
| Warm pool, 1 stream | 48 ms | 77 ms | — |

The brief's "2–3 s and ~400 MB per PDF" is consistent with launch-per-request
on slower hardware plus network-loaded fonts/assets. With a warm pool the per-PDF
cost is two orders of magnitude lower, and memory stops scaling with concurrency.

### By document size, one render, unchunked vs chunked

| Lines | Pages | Unchunked time | Unchunked extra memory | Chunked (250 rows) time | Chunked extra memory |
|---|---|---|---|---|---|
| 5 | 1 | 147 ms | +53 MB | — | — |
| 200 | 9 | 251 ms | +96 MB | — | — |
| 500 | 20 | 508 ms | +131 MB | 612 ms | +104 MB |
| 1,000 | 40 | 893 ms | +266 MB | 1,098 ms | +105 MB |
| 2,000 | 78 | 1,944 ms | +544 MB | 1,981 ms | +99 MB |
| 4,000 | 155 | 7,574 ms | **+1,227 MB** | 4,637 ms | **+115 MB** |

* Unchunked memory grows ~0.3 MB per line and layout time is super-linear
  (4,000 lines takes 4× as long as 2,000). Chunked memory is **flat at
  ~105 MB regardless of size**, and above ~2,000 lines chunking is also faster.
* I could **not** reproduce the brief's OOM at 500 lines with this template on
  this machine (500 lines = +131 MB). The crash is most plausibly a product of
  launch-per-request × concurrency on a constrained host, heavy CSS, or Docker's
  64 MB `/dev/shm`. The design bounds memory anyway (heavy lane + chunking +
  container limit + recycling), so it does not depend on which of those it was.
* Chunking costs: a partly empty page at each chunk boundary, and ~25% larger
  files for chunked documents (fonts embedded once per chunk).

### Throughput, typical 12-line invoice

| Concurrent renders | PDFs/s | PDFs/min | p50 | p95 | Chromium memory |
|---|---|---|---|---|---|
| 1 | 19.9 | 1,196 | 48 ms | 77 ms | 361 MB |
| 2 | 30.4 | 1,822 | 58 ms | 101 ms | 418 MB |
| 3 | 32.0 | 1,922 | 88 ms | 189 ms | 437 MB |
| 4 | 33.2 | 1,990 | 105 ms | 248 ms | 456 MB |

2 vCPUs saturate at ~2 concurrent renders; more slots only add latency.
Hence `POOL_SIZE` ≈ vCPU count.

## Load tests (full stack: API + worker + Redis + Chromium + load generator, all on the same 2 vCPUs)

Open loop: requests arrive on a fixed schedule whether or not the server keeps
up. "Ready" = the client holds a link to a finished PDF.

### At the brief's peak: 1,000 singles/min + 6 bulk jobs/min × 100 documents

| | Result |
|---|---|
| Singles sent / done | 1,000 / 1,000 |
| Ready within 5 s | **100%** (all answered inline with 200, no polling needed) |
| Ready latency p50 / p95 / p99 / max | 167 / 565 / 664 / 772 ms |
| Bulk jobs (100 docs each, 5% are 500-line POs) | 6/6 complete, 15–26 s each |
| Peak Chromium memory | 448 MB |
| Browser crashes | 0 |

(An earlier run of the same profile: p99 383 ms, bulk 13–20 s.)

### Upper bound of the brief: 1,000 singles/min + 10 bulk jobs/min (2,000 PDFs/min)

Bulk jobs spread over 5 tenants (otherwise the per-tenant cap of 3 concurrent
bulk jobs rejects them, which is that limit working, not a capacity result).

| | Result |
|---|---|
| Singles within 5 s | **100%**, p50 / p95 / p99 = 177 / 497 / 581 ms |
| Bulk jobs (10 × 100) | all complete; 17 s for the first, rising to 52 s for the last |
| Peak bulk backlog | 585 documents, drained ~45 s after the peak minute |
| Peak Chromium memory | 472 MB, 0 crashes |

This is the design working as intended: single requests own their reserved
slot and keep their SLA; bulk absorbs the shortfall by queueing. One 2-vCPU box
does ~1,800 mixed PDFs/min, so a *sustained* 2,000/min would grow the bulk
backlog without bound. Bulk queue wait is therefore the autoscaling signal
(add a spot worker), not CPU.

### Overload: 2,500 singles/min + 6 bulk/min (2.5× the stated peak)

The box tops out around ~1,800 PDFs/min of mixed work. What matters is how it
fails:

| Admission control | Accepted | Rejected (429) | Accepted: p50 / p99 ready | Peak queue |
|---|---|---|---|---|
| Static: reject above 400 queued (first attempt) | 1,064 | 603 | **20.0 s / 25.1 s** | 410 |
| Estimated wait > 6 s | 790 | 877 | 6.0 s / 7.6 s | 116 |
| **Estimated wait > 4 s (final)** | 787 | 880 | **3.8 s / 5.0 s** | 78 |

The static cap was a mistake: by the time 400 jobs were queued, every accepted
user was already waiting 20 s. Admission based on backlog ÷ measured
throughput keeps accepted requests inside the 5 s budget and tells everyone else
immediately (`429` + `Retry-After`), which is also the signal to scale out.
Bulk jobs kept completing throughout (16–25 s); the per-tenant cap of 3 active
bulk jobs rejected the excess.

## Chaos test

`scripts/chaos.js` SIGKILLs Chromium twice during a 30-document bulk run
(10 of them 700-line POs) — the same thing the kernel OOM-killer does.

Result: 30/30 delivered, 2 jobs retried automatically, browser relaunched twice,
no manual intervention.

## Reproducing

```bash
npm run bench                                   # renderer only
node scripts/loadtest.js --rate 1000 --duration 60 --bulk-per-min 6
node scripts/loadtest.js --rate 2500 --duration 40 --bulk-per-min 6
node scripts/chaos.js
```
