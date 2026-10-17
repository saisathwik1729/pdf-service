"""
Building document payloads inside the monolith — and why bulk snapshots are
taken in ONE transaction.

The stale-GST-invoice incident: generation of PDF #87 read the ERP ~3 minutes
after the user clicked "Export", and an edit landed in between. The fix is to
read every document of the batch at the moment the user clicks, inside a
single REPEATABLE READ transaction, so all 100 payloads come from the same
consistent database snapshot. The PDF service then renders only from those
payloads; it never reads the ERP. Each PDF prints "Data as of <snapshot_at>".

The model names below (Invoice, PurchaseOrder, ...) are placeholders for the
real ERP models; only the shape of the payload matters to the service.
"""
from __future__ import annotations

from decimal import Decimal

from django.db import connection, transaction
from django.utils import timezone

# from erp.models import Invoice, PurchaseOrder   # real models live in the monolith


def _money(v: Decimal | None) -> float | None:
    # The ERP owns rounding; we pass its already-rounded figures through.
    return None if v is None else float(v)


def _party(p) -> dict:
    return {
        "name": p.legal_name,
        "address": p.address_text,
        "gstin": p.gstin or None,
        "state": p.state_name,
        "state_code": p.state_code,
        "phone": p.phone or None,
        "email": p.email or None,
    }


def invoice_payload(inv) -> dict:
    items = [
        {
            "description": line.description,
            "item_code": line.sku,
            "hsn": line.hsn_code,
            "qty": float(line.quantity),
            "unit": line.uom,
            "rate": _money(line.unit_price),
            "discount_pct": float(line.discount_pct or 0),
            "taxable_value": _money(line.taxable_value),
            "tax_rate": float(line.gst_rate),
            "cgst": _money(line.cgst),
            "sgst": _money(line.sgst),
            "igst": _money(line.igst),
            "total": _money(line.line_total),
        }
        for line in inv.lines.all()  # prefetched, see below
    ]
    return {
        "type": "invoice",
        "document_id": str(inv.pk),
        "version": inv.updated_at.isoformat(),  # row version at snapshot time
        "data": {
            "number": inv.number,
            "date": inv.invoice_date.isoformat(),
            "due_date": inv.due_date.isoformat() if inv.due_date else None,
            "po_reference": inv.customer_po or None,
            "place_of_supply": inv.place_of_supply_label,
            "supply_type": "intra" if inv.is_intra_state else "inter",
            "reverse_charge": inv.reverse_charge,
            "payment_terms": inv.payment_terms_label,
            "seller": _party(inv.company),
            "buyer": _party(inv.customer),
            "items": items,
            "totals": {
                "taxable": _money(inv.taxable_total),
                "cgst": _money(inv.cgst_total),
                "sgst": _money(inv.sgst_total),
                "igst": _money(inv.igst_total),
                "round_off": _money(inv.round_off),
                "grand_total": _money(inv.grand_total),
            },
            "einvoice": {"irn": inv.irn, "ack_no": inv.ack_no, "ack_date": inv.ack_date.isoformat()} if inv.irn else None,
            "notes": inv.notes or None,
            "terms": inv.terms or None,
        },
    }


def snapshot_invoices(invoice_qs, invoice_ids: list[int]) -> tuple[str, list[dict]]:
    """
    Read all invoices of a bulk export from one consistent snapshot.
    Returns (snapshot_at, payloads). Call OUTSIDE any existing transaction.
    """
    with transaction.atomic():
        if connection.vendor == "postgresql":
            # Must be the first statement of the transaction.
            with connection.cursor() as cur:
                cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        snapshot_at = timezone.now().isoformat()
        invoices = (
            invoice_qs.filter(pk__in=invoice_ids)
            .select_related("company", "customer")
            .prefetch_related("lines")  # 3 queries total, not 1 + 100 + 100
            .order_by("invoice_date", "number")
        )
        payloads = [invoice_payload(inv) for inv in invoices]
    return snapshot_at, payloads
