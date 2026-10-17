"""
Example views wiring the monolith to the PDF service. Three touch points:

  GET  /invoices/<id>/pdf          -> 302 to the PDF service's signed link
  POST /invoices/export            -> starts a bulk run, returns progress URLs
  POST /hooks/pdf-service          -> webhook when a bulk run finishes
"""
from __future__ import annotations

import json

from django.contrib.auth.decorators import login_required
from django.http import HttpResponseRedirect, JsonResponse, HttpResponseBadRequest, HttpResponseForbidden
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from . import pdf_client
from .snapshots import invoice_payload, snapshot_invoices

# from erp.models import Invoice, BulkExport


@login_required
def invoice_pdf(request, pk):
    inv = get_object_or_404(Invoice.objects.for_user(request.user).select_related("company", "customer").prefetch_related("lines"), pk=pk)  # noqa: F821
    try:
        link = pdf_client.request_document(invoice_payload(inv))
    except pdf_client.PdfServiceBusy as e:
        return JsonResponse({"error": "busy", "retry_after": e.body["retry_after"]}, status=503)
    # The browser now waits on the PDF service, not on this gunicorn worker.
    return HttpResponseRedirect(link.download_url)


@login_required
@require_POST
def export_invoices(request):
    ids = [int(x) for x in json.loads(request.body)["invoice_ids"]][:100]
    snapshot_at, payloads = snapshot_invoices(Invoice.objects.for_user(request.user), ids)  # noqa: F821
    job = pdf_client.start_bulk(
        payloads,
        label=f"Invoices {snapshot_at[:10]}",
        snapshot_at=snapshot_at,
        callback_url=request.build_absolute_uri(reverse("pdf-service-hook")),
    )
    BulkExport.objects.create(user=request.user, bulk_id=job["bulk_id"], status="queued", snapshot_at=snapshot_at)  # noqa: F821
    # The ERP's own page subscribes to events_url (Server-Sent Events) for the
    # progress bar; no polling load on the monolith.
    return JsonResponse({"bulk_id": job["bulk_id"], "events_url": job["events_url"], "status_url": job["status_url"]}, status=202)


@csrf_exempt
@require_POST
def pdf_service_hook(request):
    if not pdf_client.verify_webhook(
        request.body,
        request.headers.get("X-PdfSvc-Timestamp"),
        request.headers.get("X-PdfSvc-Signature"),
    ):
        return HttpResponseForbidden("bad signature")
    event = json.loads(request.body)
    if event.get("event") != "bulk.completed":
        return HttpResponseBadRequest("unknown event")
    BulkExport.objects.filter(bulk_id=event["bulk_id"]).update(  # noqa: F821
        status=event["status"], done=event["done"], failed=event["failed"], parts=event["parts"]
    )
    # e.g. notify the user in-app / by email with the part links here.
    return JsonResponse({"ok": True})
