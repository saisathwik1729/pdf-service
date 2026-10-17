"""
Thin client the Django monolith uses to talk to the PDF service.

Design rule: a gunicorn worker on the 2-vCPU monolith must NEVER sit waiting
for a render. At ~1000 PDF requests/min, holding each request for even 2-3s
would pin 35-50 sync workers on a box that runs maybe 5-9. So:

  * Django sends the snapshot with wait=0 and gets back, within ~20ms, a
    signed download link.
  * Django answers the user's browser with a redirect to that link.
  * The browser waits on the PDF service (Node, async: an open socket costs
    a few KB, not a thread). If the PDF is ready within ~5s the download
    starts; otherwise the user sees a "preparing" page that auto-refreshes.

No PDF bytes ever pass through Django.

Settings expected:
    PDF_SERVICE_URL = "http://10.0.1.25:8080"      # private IP in the same VPC
    PDF_SERVICE_API_KEY = env("PDF_SERVICE_API_KEY")
    PDF_SERVICE_WEBHOOK_SECRET = env("PDF_SERVICE_WEBHOOK_SECRET")
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass

import requests
from django.conf import settings

_session = requests.Session()  # connection pooling across requests in a worker
_TIMEOUT = (1.0, 5.0)  # connect, read. Validation + enqueue takes ~10-40ms.


class PdfServiceError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(f"PDF service returned {status}: {body.get('message') or body.get('error')}")
        self.status = status
        self.body = body


class PdfServiceBusy(PdfServiceError):
    """429: admission control kicked in. Retry-After is in body['retry_after']."""


@dataclass
class PdfLink:
    doc_key: str
    status: str  # queued | rendering | done
    download_url: str
    status_url: str
    verify_url: str


def _post(path: str, payload: dict) -> tuple[int, dict, dict]:
    resp = _session.post(
        f"{settings.PDF_SERVICE_URL}{path}",
        data=json.dumps(payload, default=str),
        headers={"Content-Type": "application/json", "X-API-Key": settings.PDF_SERVICE_API_KEY},
        timeout=_TIMEOUT,
    )
    try:
        body = resp.json()
    except ValueError:
        body = {"error": resp.text[:200]}
    return resp.status_code, body, resp.headers


def request_document(payload: dict) -> PdfLink:
    """Queue one document; returns immediately with a link the browser can follow."""
    status, body, headers = _post("/v1/documents?wait=0", payload)
    if status == 429:
        body["retry_after"] = int(headers.get("Retry-After", "5"))
        raise PdfServiceBusy(status, body)
    if status not in (200, 202):
        raise PdfServiceError(status, body)
    return PdfLink(body["doc_key"], body["status"], body["download_url"], body["status_url"], body["verify_url"])


def start_bulk(documents: list[dict], *, label: str, snapshot_at: str, callback_url: str | None = None) -> dict:
    """Queue up to 100 documents. Returns {bulk_id, status_url, events_url, ...}."""
    status, body, headers = _post(
        "/v1/bulk",
        {"label": label, "snapshot_at": snapshot_at, "callback_url": callback_url, "documents": documents},
    )
    if status == 429:
        body["retry_after"] = int(headers.get("Retry-After", "30"))
        raise PdfServiceBusy(status, body)
    if status != 202:
        raise PdfServiceError(status, body)
    return body


def verify_webhook(raw_body: bytes, timestamp: str, signature: str, *, tolerance_s: int = 300) -> bool:
    """Check X-PdfSvc-Signature on a webhook (HMAC-SHA256 over 'timestamp.body')."""
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > tolerance_s:  # replay protection
        return False
    expected = "sha256=" + hmac.new(
        settings.PDF_SERVICE_WEBHOOK_SECRET.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature or "")
