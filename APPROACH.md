# Approach Document

> **How to read this.** Every performance number below was **measured** on the
> working implementation in this repo (`docs/benchmarks.md`, raw JSON in `docs/`).
> Prices are cited at the end of §8. Where something is an estimate or untested,
> it says so.

## 1. Initial Understanding

> ✍️ **Sai: write this section yourself, in your own words, before submitting.**
> The template asks what you thought *before* using any AI, and the evaluators
> will compare it with your AI conversation. Please don't submit the prompts
> below as your answer — replace this whole block. Prompts to help you recall:
>
> - When you first read the brief, which constraint looked hardest to you, and why?
> - Did "2–3 s and 400 MB per PDF" × "1,000 requests/min" feel compatible with ₹12,500/month?
> - What did you expect to be the cause of the 500-line OOM crash?
> - What was your first idea for the stale-GST-invoice problem? For tamper evidence?
> - What did you not know (BullMQ? S3 Object Lock? HTTP Range?) and had to look up?

## 2. Assumptions & Clarifying Questions

### Assumptions I made

| # | Assumption | Why it matters | If wrong |
|---|---|---|---|
| A1 | "1,000 requests/min" is a **burst** (month-end GST filing, dispatch hour), not sustained. 30,000 PDFs/month averages 0.7/min; at 1,000/min the whole month's volume is used up in 30 minutes. | A small always-on base plus burst capacity paid per use, instead of a peak-sized fleet that idles 99.97% of the time (§3.4). | Sustained peaks → the burst tier stays up longer and cost rises (§8 sensitivity). |
| A2 | I size everything on the brief's **2–3 s and 400 MB per PDF** (§3). I suspect these reflect launching a browser per request, since my warm-pool measurements are far cheaper, but measurements only lower the bill; they don't change the design. | It decides the whole capacity plan and cost. | If renders really are that cheap, the burst tier stays at zero (§3.9). |
| A3 | The ERP owns all money math (taxes, rounding). The PDF service **formats and validates**, it never computes amounts. | One source of truth for GST figures. | — |
| A4 | The service is **multi-tenant** (TranZact serves many SMBs): per-tenant API keys, storage prefixes, bulk limits. | Fairness and isolation. | Single-tenant still works unchanged. |
| A5 | Templates live in this service and are **versioned**; the ERP sends data, not HTML. | Same data + same template version → identical document, which enables caching and audit. | — |
| A6 | Region ap-south-1 (Mumbai), Indian GST documents, IST timestamps, ₹. | Data residency, pricing, formatting. | — |
| A7 | Retention: **8 years**. CGST Act s.36 requires accounts to be kept 72 months from the due date of the annual return, i.e. up to ~7.5 years after the invoice. | Object Lock retention, archive cost. | Legal should confirm; it's one env var. |
| A8 | The ERP's download button can be changed to follow a link / redirect. | Lets the browser, not a gunicorn worker, wait for the render (Decision 7). | — |
| A9 | ₹12,500/month at ~₹83.3/$ (the brief's own conversion) for **this service** for one customer's 30k PDFs. | Cost section. | See Q2. |
| A10 | CPU per PDF ≈ 1 vCPU while rendering (not given). | Slots per worker = min(vCPU, RAM ÷ 400 MB). | If renders mostly wait on I/O, more slots fit per box: cheaper. |
| A11 | PDF size per the brief, **100 KB – 1 MB**; costs are computed at the **1 MB upper bound**. | Storage, bandwidth, cost. | Smaller files only lower cost. |

### Questions I'd ask before starting

**Product / business**
1. Is the 1,000/min peak sustained or bursty? How many minutes per day, which days? Aggregate across all customers, or one?
2. Is ₹12,500/month the budget for one customer, or for a shared service serving all customers? (Very different architectures.)
3. GST Rule 48 requires goods invoices in **triplicate** (Original for Recipient / Duplicate for Transporter / Triplicate for Supplier). Should one request produce all three copies?
4. Do customers above the e-invoicing threshold need the **IRN and signed QR** from the IRP printed? Who obtains them, the ERP or this service? (The payload already supports passing them through.)
5. Who must be able to verify tamper evidence: internal compliance, auditors, or the invoice recipient in Adobe Reader? The last one needs a PAdES signature with a DSC, which is a much bigger piece of work (§6).
6. Per-tenant branding (logo, colours, custom fields)? Regional languages on invoices?
7. When ERP data changes after a PDF was generated, should the old PDF stay valid (it's an issued document) or be superseded? (I assumed issued documents are immutable and a new render is a new version.)

**Engineering**
8. What sits in front of the Django EC2 today: nginx? an ALB? Where is TLS terminated? (Determines how browsers reach the service at zero extra cost.)
9. Is there Celery/RQ in the monolith, or only synchronous gunicorn? How many gunicorn workers?
10. Does the monolith's VPC have a NAT gateway already? (If not, don't create one for this: §8.)
11. Expected PDF size distribution: what fraction of POs have 500+ lines?
12. Observability stack in use (CloudWatch, Grafana, Sentry)?

## 3. Capacity Planning & Math

**All sizing below uses the numbers given in the brief.** Where the brief is
silent I state the assumption. My own measurements appear only in §3.9, as a
check; they are never used to size the system.

### 3.1 Inputs

| Input | Value | Source |
|---|---|---|
| Single requests at peak | 1,000/min = **16.7/s** | given |
| Bulk at peak | 5–10 requests/min × up to 100 = 500–1,000 docs/min = **8.3–16.7/s** | given |
| Time per PDF | **2–3 s** (2.5 s typical, 3 s worst case) | given |
| Memory per PDF | **~400 MB** while rendering | given |
| PDF size | **100 KB – 1 MB** | given |
| Monthly volume | **30,000 PDFs** | given |
| Latency | single download starts **≤ 5 s**; bulk "reasonable", with progress | given |
| Budget | **₹12,500 ≈ $150/month** | given |
| CPU per PDF | ~1 vCPU while rendering | **assumed**: the brief gives time and memory, not CPU. Chromium lays out and prints a page mostly on one thread |
| Request payload | 4 KB (12-line invoice) to 125 KB (500-line PO) of JSON per document | measured from the payload schema (the brief doesn't say) |
| Fixed overhead per worker | ~1.2 GB (OS, Docker, Node, idle Chromium) | measured |

### 3.2 Concurrency at peak (Little's law: in flight = arrival rate × time)

```
singles   16.7/s × 2.5 s            = 42 in flight    (at 3 s: 50)
bulk      8.3–16.7/s × 2.5 s        = 21–42           (at 3 s: 25–50)
total                               = 63–84           (at 3 s: 75–100)
```

A single request may wait at most 5 s − 3 s = **2 s** in a queue, so the 42–50
slots for singles must already exist when a burst arrives. Bulk may queue.

### 3.3 Memory and CPU at peak

```
memory   63–84 × 400 MB  = 25–34 GB   (+ per-worker overhead)
CPU      63–84 vCPU                  (at the 1 vCPU/PDF assumption)
```

Provisioning that permanently costs about 42 × c7i.large ≈ **$2,700/month,
~18× the budget**. So the budget rules out sizing for peak around the clock.

### 3.4 The key observation: the volume limits how long a peak can last

```
monthly render work   30,000 × 2.5 s            = 75,000 s = 21 slot-hours
average concurrency   75,000 s ÷ 2,628,000 s    = 0.03 slots
max peak duration     30,000 ÷ 1,500–2,000/min  = 15–20 minutes per month
```

Even if every PDF of the month arrived at peak rate, the peak would last 20
minutes. A peak-sized fleet would sit ~99.97% idle. The economical shape is a
**small always-on base plus burst capacity paid per use.**

### 3.5 Sizing the two tiers

Render slots per worker = min(vCPUs, (RAM − 1.2 GB) ÷ 0.4 GB):

| Tier | Instance | vCPU / RAM | Slots | PDFs/min at 2.5 s | Price |
|---|---|---|---|---|---|
| Base, always on (API + Redis + worker) | c7i.large | 2 / 4 GB | min(2, 7) = **2** | 48 | $0.0892/h on-demand |
| Burst workers, 0 → 10 | c7i.2xlarge | 8 / 16 GB | min(8, 37) = **8** | 192 | ~$0.16/h spot |

* **Off-peak:** average demand is 0.7 PDFs/min; the base box's 48/min covers every normal minute.
* **Peak:** 63–84 slots = base 2 + **8–10 burst instances**.
* **Scaling signal:** estimated queue wait (backlog ÷ measured throughput), exported at `/metrics` as `pdfsvc_estimated_wait_seconds`. Not CPU: bulk can saturate CPU harmlessly; a growing wait is what users feel.
* **Spot is safe here:** if AWS reclaims a burst instance, its in-flight jobs are re-delivered by BullMQ (chaos-tested by killing Chromium mid-batch).
* **No new code:** burst workers run the same image in the worker role against the base box's Redis and S3. Verified locally: a second worker process shared a 60-document batch (28 and 45 renders) with no changes.

**Honest limit:** bringing up burst capacity takes ~1–2 minutes (alarm + instance start from a warm pool). If renders really take 2.5 s, the first minute of an *unannounced* burst will push some single downloads past 5 s. During that window, admission control keeps accepted requests within budget and answers the rest immediately ("preparing" page or 429 + Retry-After) instead of letting them hang. Two further mitigations:
1. **Scheduled pre-warming** for predictable peaks: GSTR-1 is due on the 11th, GSTR-3B on the 20th, plus month-end.
2. **Optional Lambda overflow**, which scales in seconds. At the brief's numbers, even sending *all* 30k PDFs there would cost ~$3/month of compute (Decision 1). Designed, not implemented.

### 3.6 Burst-tier cost at the brief's numbers

```
actual render work      25 slot-hours ÷ 8 slots          =   3 instance-hours  ≈  $0.50
scale-out overhead      60 events/month (2/day) × 10 instances × 15 min minimum
                        = 150 instance-hours × $0.16                            ≈ $24.00
pre-warm on filing days 3 days × 4 h × 6 instances × $0.16                      ≈ $11.52
warm pool (stopped)     4 instances × 20 GB gp3 × ~$0.091/GB-month              ≈  $7.28
total                                                                           ≈ $43/month
```

The overhead line is deliberately pessimistic. It dwarfs the actual work.

### 3.7 Bandwidth (bytes per second, using the brief's 100 KB – 1 MB)

```
singles   16.7/s × 0.1–1 MB          = 1.7–16.7 MB/s   (13–133 Mbit/s)
bulk      8.3–16.7/s × 0.1–1 MB      = 0.8–16.7 MB/s   (7–133 Mbit/s)
peak                                 ≤ 33 MB/s ≈ 267 Mbit/s
bulk payload in                      ≤ 12.5 MB/request × 10/min ≈ 2 MB/s
```

* With the S3 driver, users download **from S3** (302 to a presigned URL), so this egress is S3's, not the instance's.
* Instance traffic is uploading PDFs to S3 and reading them back for zips. That's the same ≤ 33 MB/s, spread over the base box and up to 10 burst workers, each well inside its baseline network bandwidth.
* **Monthly egress:** 30,000 × 0.1–1 MB = 3–30 GB, plus zip downloads of the bulk share (assumed half) 1.5–15 GB, giving **4.5–45 GB/month**. This sits inside AWS's 100 GB/month free allowance unless the ERP already uses it; see §8.

### 3.8 Storage and Redis

```
new archive       30,000 × 0.1–1 MB = 3–30 GB/month
after 12 months   36–360 GB
after 8 years     288 GB – 2.9 TB     (retention: assumption A7)
```

At the upper end, archive objects must move to Glacier Instant Retrieval after
90 days, or storage alone grows to $72/month (§8).

Redis holds only small state:

* **Interactive queue:** admission control caps it at throughput × 4 s. At 1,000/min that's ≤ ~70 jobs × 4–125 KB = **0.3–9 MB**.
* **Bulk queue:** ≤ 1,000 jobs/min at peak; if burst capacity lags 2 min, up to ~2,000 jobs. Jobs carry only a pointer (~0.5 KB, payloads live in object storage), so **~1 MB**.
* **Document records cache:** ~1 KB × 30k/month with a 30-day TTL = **30–40 MB**.
* Redis runs with `maxmemory 256mb` and `noeviction`, so under pressure it refuses writes instead of silently dropping queued jobs.

> **Correction found while doing this math:** the first version kept the
> SHA-256 → record index in Redis with no expiry. At the upper size bound over
> 8 years that's ~0.6 GB in a Redis capped at 256 MB that also holds the queues,
> so it would eventually start refusing *new jobs*. The durable index now lives
> in object storage (`index/sha256/…`); Redis only caches it for 30 days.

### 3.9 Check against measurement (not used for sizing)

I built the renderer and measured it on 2 vCPUs (`docs/benchmarks.md`):

| | Brief | Measured, this implementation |
|---|---|---|
| Time per typical PDF | 2–3 s | 48 ms p50 (warm browser pool) |
| Memory | ~400 MB per PDF | ~450–500 MB for the whole pool, flat with concurrency |
| Size | 100 KB – 1 MB | 87–210 KB |
| Base box alone at 1,000/min + 10 bulk/min | — | 100% of singles < 5 s, p99 581 ms |

The gap is plausibly launch-a-browser-per-PDF (252 ms here, more on slower
hardware), network-loaded fonts and images, and heavier real templates. Two
outcomes, same design:

* **If production behaves like the measurements:** the burst tier never scales out, and cost is the base box plus the warm pool.
* **If production behaves like the brief:** the burst tier absorbs the peaks within budget (§8).

Only the bill changes, not the architecture. Full load-test results: `docs/benchmarks.md`.

## 4. Design Decisions (minimum 3)

### Decision 1: A small always-on base box plus an elastic burst tier

**Alternatives considered:**
- **Size for peak, always on:** 63–84 render slots, 25–34 GB, ~$2,700/month (§3.3). ~18× the budget and ~99.97% idle.
- **Inside the existing Django EC2:** $0 extra, but at 400 MB per render a handful of concurrent PDFs would exhaust the box Django lives on, and the brief forbids re-architecting the monolith.
- **Lambda + `@sparticuz/chromium` for everything:** at the brief's numbers, 30k × 1.77 GB × 3 s ≈ 160k GB-s ≈ **$2.70/month**, and it scales in seconds. Downsides:
  - every invocation launches its own Chromium (cold starts of 1–3 s are commonly reported; I didn't measure Lambda), which leaves little of the 5 s budget;
  - bulk progress (SSE), long-poll downloads and job state would need API Gateway + DynamoDB + Step Functions or similar;
  - local development no longer matches production.
- **ECS Fargate:** managed, but roughly $80/month (estimate) for one always-on 2 vCPU / 4 GB task, plus an ALB (~$18/month) to reach it, before any burst capacity.
- **Burstable t3 instances:** CPU credits run out exactly at month-end peaks and throttle to the baseline.

**Chosen approach:**
- **Base, always on:** one c7i.large (2 vCPU, 4 GB) running API + dedicated Redis + a worker with 2 render slots. That's 48 PDFs/min at the brief's numbers, against an average demand of 0.7/min.
- **Burst:** an Auto Scaling group of 0–10 **spot** c7i.2xlarge running the same image in the worker role, 8 slots each. It scales out on `pdfsvc_estimated_wait_seconds` and is pre-warmed on GST filing days (`docs/deployment.md`).
- Inside each worker: one long-lived `chrome-headless-shell`, render slots capped by min(vCPU, RAM ÷ 400 MB), warm pages reused.

**Why:**
- The monthly volume caps the peak at ≤ 20 minutes per month (§3.4), so per-use capacity is the only shape that fits the budget.
- Workers coordinate through Redis, so adding capacity needs no code (verified with two workers locally).
- Spot interruptions are harmless because jobs are re-delivered.
- x86, because Chrome for Testing (what Puppeteer installs) has no linux-arm64 build.
- Measurements show the base box alone carries the full peak; if production matches them, the burst tier simply stays at zero.

**Tradeoff accepted:**
- At the brief's numbers, scale-out takes ~1–2 minutes, so the first minute of an **unannounced** burst sends some users to the "preparing" page or a 429 instead of a 5 s download.
- If that's unacceptable, the next step is **Lambda as the overflow tier only**: seconds to scale, ~$3/month even if it rendered everything. I'd add it behind the same queue rather than replace the base box.
- The base box is a single point of failure (§6).

### Decision 2: Separate API and worker processes; BullMQ on a **dedicated** Redis; two priority lanes

**Alternatives considered:** render inside the API process; SQS; reuse the ERP's existing Redis; Celery in the monolith (Python has no maintained Puppeteer, and it puts Chromium on the Django box).

**Chosen approach:** API (Fastify) never touches Chromium. The worker consumes three BullMQ queues: `pdf-interactive`, `pdf-bulk`, `pdf-zip`. Bulk may use at most `BULK_CONCURRENCY` slots, so at least one slot is always free for a user waiting on a single PDF. Redis runs next to them with `noeviction` and AOF.

**Why:**
- A Chromium crash or OOM kill takes down only the worker; the API keeps accepting work and BullMQ re-delivers the in-flight jobs (chaos-tested: 2 SIGKILLs mid-bulk, 30/30 delivered).
- **Not the ERP's Redis:** it's a cache, almost certainly `allkeys-lru`. Under memory pressure LRU evicts *queue keys*, and jobs vanish silently. Queues need `noeviction`, and that's a per-instance setting.
- BullMQ gives retries with backoff, stalled-job recovery, job-id deduplication and priorities without new AWS services. SQS would also work (and is free at this volume) but adds polling latency on the 5 s path and a second place to keep progress state.
- Job id = content hash, so identical concurrent requests (a user double-clicking) coalesce into one render.

**Tradeoff accepted:** Redis on the same box shares its fate; mitigated by AOF (≤1 s of job loss) and by the fact that the archive and records live in S3. At 10× I'd move it to ElastiCache (§6).

### Decision 3: Large documents: heavy lane + chunked rendering + adaptive retry

**Alternatives considered:** just give Chromium more memory; ask the ERP to paginate; stream rows into the page with JavaScript; hard limit on line items.

**Chosen approach:** documents with > 300 lines go to a **heavy lane**:
1. Line items split into 250-row chunks; each chunk printed on a fresh page (memory released between chunks); chunks merged with pdf-lib; "Page X of Y" and the footer stamped *after* merging so numbering is continuous.
2. At most one heavy document per worker at a time, so worst-case memory is bounded by design.
3. If a render fails (crash, timeout), BullMQ retries it **with chunks halved each attempt** (250 → 125 → 62 → min 40). A normal document that crashes is retried in halves too.
4. Container `mem_limit: 2g` and Chromium recycling at 1.2 GB are the last line of defence; a kill only re-queues work.

**Why:** measured, unchunked memory grows ~0.3 MB/line and layout time is super-linear (4,000 lines: +1.2 GB, 7.6 s). Chunked memory is flat at ~105 MB whatever the size, and for 2,000+ lines chunking is also faster (4,000 lines: 4.6 s). Honest note: **I couldn't reproduce an OOM at 500 lines** with this template (+131 MB); the brief's crash most likely came from launch-per-request × concurrency, heavy CSS, or Docker's 64 MB `/dev/shm` (fixed with `--disable-dev-shm-usage`). The design doesn't depend on which.

**Tradeoff accepted:** a partly empty page at each chunk boundary, ~25% larger files for chunked documents (fonts embedded per chunk), and slightly more code (merge + stamping path).

### Decision 4: Data consistency: snapshot at trigger time, render only from the snapshot

**Alternatives considered:**
- PDF service reads the ERP database when it renders (the likely cause of the incident: PDF #87 read data 3 minutes later).
- Re-check `updated_at` before rendering and re-queue if changed: produces a batch from mixed points in time, and loops if edits keep happening.
- Lock the rows during generation: blocks users for minutes.
- Read replica: replication lag makes it worse, not better.

**Chosen approach:**
1. When the user clicks Export, Django reads all ≤100 documents in **one `REPEATABLE READ READ ONLY` transaction** (`integration/django/snapshots.py`), so every payload comes from the same database snapshot, and sends them with `snapshot_at`.
2. The API **persists every payload to object storage before acknowledging**. Workers render only from those persisted payloads, never from the live ERP, including on retries and on "retry failed".
3. Every PDF prints "Data as of <snapshot time>" in its footer, and the signed record carries `snapshot_at` and the row's `data_version`.
4. Content-addressed caching: the cache key is a hash of the data itself, so an edited invoice can never be served a stale cached PDF.

**Why:** consistency comes from the moment of the click, not from how fast the renderer is. A batch is internally consistent (all 100 from one instant), reproducible, and auditable ("this is what the ERP said at 10:42:07").

**Tradeoff accepted:** if an invoice is edited *after* the click, the batch shows the pre-edit version. That's correct for "export what I selected" but must be visible, hence the footer. Bulk payloads cost a little storage (≤12.5 MB per bulk, expired after 7 days). And Django holds a read transaction for the ~100 ms the snapshot takes.

### Decision 5: Unreliable connections: zip parts, resumable downloads, progress that survives reconnects

**Alternatives considered:** stream a zip on the fly as files finish (any drop restarts the whole download, and the server can't send `Content-Length` or support Range); one big zip; emailing a link.

**Chosen approach:**
- Zip is built **once** after the batch completes, in **parts of ≤ 25 MB**, `STORE` method (PDFs are already compressed, so deflating wastes CPU). Each part includes `MANIFEST.json` and `SHA256SUMS`.
- Downloads support **HTTP Range + If-Range + ETag** (S3 does this natively via presigned URLs; the local driver implements it). The console's downloader fetches 1 MB ranges, keeps partial bytes when a connection drops, resumes from the last byte, and checks SHA-256 before saving. Demo: "simulate unreliable connection" drops ~1/3 of requests mid-stream; downloads still complete and verify.
- Every PDF is also individually downloadable, and available as soon as it's done, not after the whole batch.
- Progress is pushed over **Server-Sent Events**. `EventSource` reconnects by itself, and every (re)connect begins with a full snapshot, so a client that missed events is never wrong. Plus a pollable status URL and an HMAC-signed webhook to Django.

**Why:** for an SMB on a flaky 4G connection, the cost of a drop becomes "re-fetch at most one 1 MB range" instead of "start 60 MB again".

**Tradeoff accepted:** zip bytes are stored twice (inside the zip and in the archive) for 7 days; the user waits for the batch to finish before the zip exists (individual files are available immediately).

### Decision 6: Tamper evidence: SHA-256 + Ed25519-signed record + S3 Object Lock + public verification

**Alternatives considered:**
- **PAdES signature with a DSC** (signature embedded in the PDF, verifiable in Adobe Reader): the strongest, but needs a certificate from a CA, an HSM/KMS integration and per-document signing work. Overkill unless recipients must verify offline in Reader (Q5).
- Hashes stored in our DB only: an admin with DB access could change both file and hash.
- Blockchain / public hash anchoring: complexity with no requirement behind it.

**Chosen approach:**
1. After rendering, SHA-256 of the exact bytes.
2. A record `{doc_key, number, sha256, bytes, pages, snapshot_at, generated_at, template_version, …}` is **signed with Ed25519** (key from SSM, never in the image). The public key is published at `/v1/keys`.
3. PDF + signed record written to S3 with **Object Lock in COMPLIANCE mode** for 8 years: not even the root account can overwrite or delete them.
4. `/verify` (public, no login; the PDF's QR code points to it): upload a PDF → fingerprint → signed record → **Authentic**, or **Altered** (the PDF claims to be one of ours via its title ref, but the bytes differ), or **Not issued by us**.
5. Bulk zips' `MANIFEST.json` contains the signed records, so an auditor can verify a whole batch **offline** with the public key.

**Why:** it proves "this exact file is what we generated" with no PDF-internals complexity: three independent guarantees (immutable storage, signed record, recomputable hash), all cheap.

**Tradeoff accepted:** the signature is detached, so Adobe Reader won't show a green tick; verification goes through our page or the manifest. Key rotation is supported by `key_id` in every record but not automated.

### Decision 7: Single downloads that feel synchronous without blocking Django

**Alternatives considered:** Django calls the service and waits for the PDF (simple, but each waiting request pins a gunicorn worker: at the brief's 2.5 s per PDF, 16.7 req/s × 2.5 s = 42 workers busy just waiting, on a 2-vCPU box that has maybe 5–9 of them); browser polls a status endpoint; WebSockets.

**Chosen approach:** Django sends the payload with `wait=0` (~20 ms), then **redirects the browser to a signed link**. The browser waits on the PDF service, which holds the request asynchronously (an open socket in Node costs kilobytes, not a thread) until the PDF is ready, then streams it. If it takes longer than the wait, a browser gets a tiny auto-refreshing "Preparing your PDF…" page, an API client gets `202 + Retry-After`. API clients that can wait (`wait=4000`) get the finished result inline in one round trip.

**Why:** no PDF bytes and no waiting through the monolith. Measured at peak: 100% of single requests answered inline within the request, p99 581–664 ms.

**Tradeoff accepted:** browsers talk to the PDF service (through the ERP's nginx at `/pdf/`), so links are bearer tokens: HMAC-signed, scoped to one document or batch, expiring in 7 days.

### Decision 8: Admission control by **estimated wait**, not queue length (corrected after a failed first attempt)

**Alternatives considered:**
- **No limit:** queue everything; under overload every user waits longer and longer.
- **Fixed backlog cap** (my first attempt): reject single requests when more than 400 are queued. The 2.5× overload stress test showed the queue reaching 410 and every *accepted* user waiting 20–25 s, far past the 5 s budget, before anyone was rejected.
- **CPU-based throttling:** CPU can be at 100% from bulk work while single requests are perfectly fine, so it's the wrong signal.

**Chosen approach:** estimated wait = queued single requests ÷ singles completed per second over the last 10 s (per-second counters in Redis, shared by all API instances). Above 4 s → `429` with an honest `Retry-After`. The same number is exported as `pdfsvc_estimated_wait_seconds` and drives the burst tier (Decision 1).

**Why:** it measures what the user experiences, and it adapts automatically to how fast renders currently are (brief's 2–3 s or faster) and to how many workers are running. Same overload test after the change: accepted requests p50 3.8 s / p99 5.0 s, queue never above 78, the rest got an immediate, actionable 429.

**Tradeoff accepted:** during overload some users see "busy, retrying" instead of a slow download. That's a product decision; the threshold is one env var (`MAX_QUEUE_WAIT_SEC`).

## 5. AI Usage Log

> ✍️ **Sai:** make each conversation public and paste the links here. Add any
> other AI tools you used. Then edit the notes below so they describe **your**
> part honestly: where *you* questioned or overrode the AI. Only claim what you
> actually did.

| Conversation | Tool | Used for |
|---|---|---|
| _paste public link_ | Claude | End-to-end: requirements analysis, building the service, benchmarking, load testing, docs |
| _paste link (if any)_ | | |

### Where the AI's first answer was wrong, and what caught it

Most corrections in this project came from **measurement and tests, not from reasoning**. That was deliberate: build the thing, measure it, then believe the numbers.

| First version | What exposed it | Fix |
|---|---|---|
| Capacity plan, bandwidth and storage sized on my **measured** render cost (48 ms) and file size (~150 KB) instead of the brief's **given** 2–3 s / 400 MB and 100 KB – 1 MB | **I (Sai) asked the AI to check every number against the problem statement** | §3 redone on the given numbers; design gained an elastic burst tier; costs at the 1 MB upper bound; measurements kept only as a check (§3.9) |
| Implementation launched heavy browser state per PDF (full Chrome, new context each time) | Benchmark + per-stage profiling | Warm `chrome-headless-shell` pool. Measurements are kept as a check only; sizing stays on the brief's numbers (§3.9) |
| Full Chrome, new browser context per PDF | Per-stage profiling: tab open 96 ms, render 5 ms | `chrome-headless-shell`, warm page reuse (6× throughput) |
| Puppeteer `footerTemplate` for page numbers | 4,000-line PO became **15.5 MB** | CSS `@page` margin boxes |
| Inter font (OpenType-CFF) | `pdffonts` showed Type 3 glyph fonts | Pinned Noto Sans TrueType |
| Default tagged PDFs | Object breakdown: 60% of the file was `StructElem` | `tagged: false` (noted as an accessibility tradeoff) |
| Admission control at a fixed 400-job backlog | Stress test: accepted users waited 20–25 s | Wait-based admission (Decision 8) |
| API-key check in `preHandler` | E2E test: unauthenticated requests got schema errors and could make the server parse 32 MB first | Auth moved to `onRequest` |
| Retry chunk size formula | Unit test: crashed 200-row doc retried at 50 rows, not 100 | Formula fixed |
| SHA-256 index in Redis forever | Capacity math (§3.8) | Durable index in object storage |
| "No public IP" for the PDF box | Cost check: that implies a NAT gateway, ~$40/month | Public IPv4 ($3.65), zero inbound rules, S3 gateway endpoint |
| `archiver` default import | Worker crashed on start (v8 API changed) | Named `ZipArchive` import |
| Load test with one tenant for 10 bulk/min | Per-tenant cap rejected jobs, so it measured the limit, not capacity | Bulk spread across 5 tenant keys |

## 6. Weaknesses & Future Improvements

### Weakest parts (honestly)

1. **Scale-out lag at the brief's numbers.** If renders really take 2–3 s, the first ~1–2 minutes of an unannounced burst exceed what the base box can do within 5 s; those users get the "preparing" page or a 429. Pre-warming covers predictable peaks; Lambda overflow (designed, not built) would cover the rest.
2. **Single base box.** API, Redis and the base worker share one instance. What exists: Redis AOF, S3 as the durable store, BullMQ re-delivery, container restart policies. What the deployment should add: an Auto Scaling group of size 1 so a dead instance is replaced. Burst workers keep rendering only while Redis is up.
3. **The burst tier is designed, not deployed.** The scaling metric is implemented and horizontal workers are verified locally, but the Auto Scaling group, alarms and warm pool (`docs/deployment.md`) have not been built in AWS.
4. **Not verified on AWS.** Benchmarks ran on a 2-vCPU cloud VM, not a c7i.large, with the load generator on the same machine. The **Docker image was never built** (no Docker daemon in my environment) and the **S3 storage driver was never run against S3**. Both are straightforward but untested; they'd be the first thing I'd do.
5. **Detached signatures.** Fine for compliance teams; recipients can't verify in Adobe Reader.
6. **Untagged PDFs** (accessibility) to keep sizes down.
7. **Chunk-boundary pages** in very large orders are partly empty.
8. At-least-once delivery: the webhook can fire twice after a crash at the wrong moment (Django handler is idempotent, by design, but this should be stated in the contract).
9. Verification rate limiting is in-memory per API process; `/metrics` is unauthenticated (must be firewalled).

### With 2 more days

1. Build and run the image on an actual c7i.large; repeat the load tests there; run the S3 driver against a real Object-Lock bucket (and MinIO in CI).
2. PAdES signing with a DSC (`@signpdf`) behind a flag, if Q5's answer requires it.
3. CloudWatch dashboard + alarms: estimated queue wait, 429 rate, browser crashes, bulk age.
4. Template workflow: per-tenant branding, a preview endpoint, visual regression tests (render fixtures → compare page images) so template changes can't silently move page breaks.
5. Idempotency keys on `POST /v1/bulk`, so a retried request doesn't create a second batch.
6. Fair scheduling between tenants inside the bulk queue (round-robin), not just a per-tenant cap.

### At 10× (10,000 singles/min, 50–100 bulk/min, 300k PDFs/month)

At the brief's per-PDF numbers:

```
peak in flight   167 singles/s × 2.5 s + 83–167 bulk/s × 2.5 s = 625–835 slots
memory / CPU     250–335 GB, ~625–835 vCPU at the top of the peak
monthly work     300,000 × 2.5 s = 208 slot-hours   (peak still ≤ ~20 min/month)
```

- **Burst tier becomes Lambda.** ~80–100 spot c7i.2xlarge appearing within a minute is neither fast nor guaranteed (spot capacity). Lambda scales in seconds, and 300k PDFs × ~5.3 GB-s ≈ 1.6M GB-s ≈ **$27/month** of compute. A spot ASG stays for steady bulk throughput.
- **Base:** 2+ API instances behind an ALB (already stateless: all waits go through Redis pub/sub); 2 base workers for the interactive floor.
- **Redis → ElastiCache** Multi-AZ (still `noeviction`); document records → Postgres or DynamoDB.
- **Heavy lane** as its own memory-optimised pool.
- **Rough cost:** ALB ~$18, ElastiCache ~$25–50, 2–3 base instances ~$130–200, Lambda ~$30–60, spot bulk workers ~$100–200, S3/egress growing with volume. That's **~$350–550/month** (₹0.10–0.15 per PDF, below today's ~₹0.36 worst case, because the fixed base is shared across 10× the volume).
- If renders behave like my measurements instead (~65 ms of vCPU each), 10× is ~21 vCPU at peak: about 6 c7i.xlarge workers, no Lambda needed.

## 7. One Thing the Problem Statement Didn't Mention

**The renderer is a web browser, and it's being fed customer-controlled data. That's a server-side request forgery (SSRF) hole by default.**

A customer name like `<img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/">` in an invoice, if templated without escaping and rendered by a headless browser on EC2, makes the server fetch **its own cloud credentials** and potentially print them into a PDF the attacker downloads. HTML-to-PDF services are a well-known target for exactly this, and the brief, focused on performance, doesn't mention it.

What this design does about it, in layers:
1. **Templates are rendered server-side with auto-escaping** (Handlebars); the ERP sends data, never HTML. An e2e test sends `<img …><script>…` as a buyer name and asserts it's printed as literal text.
2. **JavaScript is disabled** in rendered pages: nothing in the page can run.
3. **All network requests from the page are blocked** (request interception allows only `data:`). Fonts are installed in the image, not fetched. A second test renders raw HTML containing `<img>`, `<link>` and `<iframe>` pointing at a local probe server and asserts **zero hits**.
4. Deployment requirement (not code in this repo): launch the EC2 with **IMDSv2 required and hop limit 1**, so even a compromised container can't reach instance credentials. The image already runs Chromium as a non-root user and compose drops all Linux capabilities.

**Runners-up I'd raise with the team:** GST Rule 48 triplicate copies and e-invoice IRN/QR (Q3–Q4); pinned fonts (₹ glyph coverage and stable page breaks, see `assets/fonts/README.md`); graceful shutdown on deploys (`stop_grace_period` + draining in-flight renders); the NAT-gateway cost trap (§8).

## 8. Cost Estimation

**Basis:**
- Region ap-south-1, 730 hours/month, ₹83.3/$ (the brief's own conversion).
- Volume: 30,000 PDFs/month, about half generated through bulk.
- The **worst-case column uses the brief's numbers**: 2–3 s and 400 MB per PDF, 1 MB per PDF.
- The second column shows what happens if production behaves like my measurements. It's not used for sizing.

| # | Item | Math (worst case) | Worst case: brief's numbers | If measurements hold |
|---|---|---|---|---|
| | **Base tier, always on** | | | |
| 1 | EC2 c7i.large on-demand (API + Redis + worker) | $0.0892/h × 730 h | $65.12 | $65.12 |
| 2 | EBS gp3 30 GB | 30 × ~$0.091 *(approximate)* | $2.73 | $2.73 |
| 3 | Public IPv4 for outbound (no NAT gateway, no inbound rules) | $0.005/h × 730 h | $3.65 | $3.65 |
| 4 | S3 archive storage, month 12, lifecycle to Glacier IR at 90 days | 1 MB: 90 GB × $0.025 + 270 GB × ~$0.005 | $3.60 | $0.54 *(150 KB)* |
| 5 | S3 requests | PUT ~105k × $0.005/1k + GET ~100k × $0.0004/1k + 30k lifecycle transitions × ~$0.02/1k | $1.17 | $1.17 |
| 6 | Data transfer out | 45 GB/month × ~$0.109, if the 100 GB free allowance is already used by the ERP | $4.91 | $0 *(inside free allowance)* |
| 7 | CloudWatch Logs | ~3 GB × ~$0.67 *(approximate)* + storage | $2.10 | $2.10 |
| 8 | CloudWatch metrics + alarms (incl. scaling alarms) | 12 × $0.30 + 8 × $0.10 | $4.40 | $4.40 |
| | **Burst tier, scales from zero** (§3.6) | | | |
| 9 | Spot c7i.2xlarge for scale-out events | 150 instance-h × $0.16 | $24.00 | $0 *(never scales out)* |
| 10 | Pre-warming on GST filing days | 3 days × 4 h × 6 × $0.16 | $11.52 | $0 *(disabled)* |
| 11 | Warm pool (stopped instances, EBS only) + EBS while running | 4 × 20 GB × $0.091 + ~$0.55 | $7.83 | $7.28 |
| 12 | S3 gateway endpoint, SSM Parameter Store, signing key | free | $0 | $0 |
| | **Total** | | **$131.03 ≈ ₹10,915** | **$86.99 ≈ ₹7,246** |
| | **Share of ₹12,500 budget** | | **87%** | **58%** |
| | **Per PDF** | | **₹0.36** | **₹0.24** |

### Sensitivity

* **Commit the base instance for 1 year** ($43.14 instead of $65.12/month) to save $22: worst case **$109 (₹9,084)**.
* **Bursts twice as frequent** as assumed (120 scale-out events/month): +$24, so the worst case reaches **$155 (₹12,914), slightly over budget**. The 1-year commitment brings it back to **$133 (₹11,083)**. This is the number to watch; Q1 in §2 is how I'd pin it down.
* **Lambda as the overflow tier instead of spot** (Decision 1): ~$3/month of compute even if it rendered everything. Cheaper still, but adds a second render path.

### Archive growth: why the lifecycle rule matters

| Horizon | Stored (100 KB – 1 MB per PDF) | All S3 Standard | Standard ≤ 90 days, then Glacier IR |
|---|---|---|---|
| Month 12 | 36–360 GB | $0.90–$9.00 | $0.36–$3.60 |
| Year 8 (retention limit) | 288 GB – 2.9 TB | $7.20–**$72** | $1.85–**$16** |

Glacier Instant Retrieval keeps millisecond access, so old invoices stay
downloadable. Its 90-day minimum matches the rule, and it works with Object Lock.

### Costs deliberately avoided

| Avoided | Would cost | How |
|---|---|---|
| Sizing for peak around the clock | ~$2,700/month | Small base + per-use burst tier; volume caps peaks at ≤ 20 min/month (§3.4) |
| NAT gateway | ~$41/month + $0.056/GB | Public IPv4 with no inbound rules; S3 via free gateway endpoint |
| Application Load Balancer | ~$18+/month | ERP's existing nginx proxies `/pdf/` to the private IP |
| Lambda provisioned concurrency | ~$400/month | Not used; spot burst tier with pre-warming instead |

### Price sources

- c7i.large ap-south-1: on-demand $0.0892/h, spot $0.0389/h, 1-year RI no-upfront $43.14/month — [aws-pricing.com](https://aws-pricing.com/c7i.large.html)
- c7i.2xlarge ap-south-1: on-demand $0.357/h, spot $0.1445–$0.1663/h (I use $0.16) — [DoiT](https://www.doit.com/compute/spot/ap-south-1/c7i.2xlarge)
- c7g.large ap-south-1 (Graviton, considered): $0.0491/h — [DoiT](https://www.doit.com/compute/spot/ap-south-1/c7g.large)
- S3 Standard in Mumbai ≈ ₹2.1/GB-month (≈ $0.025) — [Precision Tech AWS India pricing guide](https://precisiontech.in/cloud/amazon-aws-cloud/aws-pricing/aws-pricing-in-indore/)
- S3 request prices, Glacier IR ($0.004/GB in us-east-1, assumed ~$0.005 in Mumbai), data transfer and the 100 GB/month free allowance — [Upstash, S3 pricing explained (2026)](https://upstash.com/blog/aws-s3-pricing-explained-2026)
- Public IPv4 $0.005/h, gp3, CloudWatch, Lambda ($0.0000166667/GB-s), lifecycle-transition and NAT gateway figures are AWS list prices from memory, marked approximate where I couldn't confirm the Mumbai rate. **Verify in the AWS Pricing Calculator before relying on them.**
