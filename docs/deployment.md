# Deployment (AWS, ap-south-1)

Two tiers. Both run the same Docker image. Capacity math: APPROACH.md §3.

## Base tier: always on

One **c7i.large** in the ERP's VPC and subnet, same AZ as the Django EC2.

- `docker compose up -d` runs `api`, `worker` and `redis`.
- Wrap the instance in an Auto Scaling group with min = max = 1, so a failed instance is replaced automatically.
- **Security group:** inbound 8080 only from the ERP instance's security group; nothing from the internet.
- **Outbound:** via the instance's public IPv4 (no NAT gateway).
- **S3:** through a free S3 gateway endpoint.
- **IMDSv2 required, hop limit 1:** containers can't reach instance credentials.
- **IAM role:** S3 read/write on the bucket (including `s3:PutObjectRetention`), SSM `GetParameter` on `/pdf-service/*`, CloudWatch `PutMetricData`.
- **Redis:** binds to the private IP for burst workers, with `requirepass` set. Keep `noeviction` and AOF.

## Burst tier: scales from zero

An Auto Scaling group of **c7i.2xlarge spot**, min 0, max 10, running only the `worker` role.

- **Instance types:** allow c7i.2xlarge, c6i.2xlarge and m7i.2xlarge, so one spot pool running dry doesn't stop scaling.
- **Environment:**
  - `REDIS_URL=redis://:<password>@<base-private-ip>:6379/0`
  - `STORAGE_DRIVER=s3`
  - `POOL_SIZE` = min(vCPU, (RAM_GB − 1.2) ÷ 0.4) = **8**
  - `BULK_CONCURRENCY=8`: the base box's reserved interactive slot still protects single requests.
- **Warm pool:** 4 instances, stopped state, AMI with the image pre-pulled. This cuts scale-out from ~3 min to ~1 min.
- **Scale out:** CloudWatch alarm on `pdfsvc_estimated_wait_seconds{queue="interactive"} > 2` for 30 s, or `{queue="bulk"} > 120` for 1 min → **+3 instances**.
- **Scale in:** both below 0.5 s for 10 min → −1 instance. Each worker drains in-flight jobs on SIGTERM (`stop_grace_period: 60s`).
- **Scheduled actions** (predictable Indian GST peaks): desired = 6 on the 10th–11th (GSTR-1), the 19th–20th (GSTR-3B) and the last business day of the month, 10:00–14:00 IST.
- **Spot interruption:** the 2-minute notice triggers the same graceful drain. Anything unfinished is re-delivered by BullMQ to another worker.

Metric export: a CloudWatch agent (Prometheus scrape of `/metrics`) or a 15-second cron that calls `/v1/stats` and runs `aws cloudwatch put-metric-data`.

## S3 bucket

- Create it **with Object Lock enabled**. Versioning comes on automatically.
- **No default retention.** The service sets `COMPLIANCE` retention per object on `archive/` and `index/`.
- **Lifecycle:**
  - `archive/` → Glacier Instant Retrieval after 90 days
  - `bulk/` → expire after 7 days
  - non-current versions → expire after 30 days, except where retention forbids it
- **CORS:** allow `GET`/`HEAD` with `Range` and `If-Range` headers; expose `Content-Range`, `Content-Length`, `ETag`.
- **Block all public access.** Downloads use presigned URLs.

## Secrets (SSM Parameter Store, SecureString)

| Parameter | Generate with |
|---|---|
| `/pdf-service/signing-private-key` | `openssl genpkey -algorithm ed25519` |
| `/pdf-service/api-keys` | one key per tenant |
| `/pdf-service/download-token-secret` | `openssl rand -base64 32` |
| `/pdf-service/webhook-secret` | `openssl rand -base64 32` |
| `/pdf-service/redis-password` | `openssl rand -base64 32` |

## ERP side

- Add `integration/nginx-pdf-service.conf` to the ERP's nginx.
- Set `PUBLIC_BASE_URL=https://<erp-domain>/pdf`.
- Drop `integration/django/` into the monolith and wire the three views.

## Status

The service, the scaling metric and horizontal workers are implemented and
tested locally. **The AWS resources on this page (both Auto Scaling groups,
alarms, warm pool, bucket policy) have not been created or tested.**
