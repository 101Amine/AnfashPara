# Inventory movement ledger

Inventory is append-only. There is no mutable `stock` column and no workflow may overwrite a stock
number. The current quantity for a SKU is always derived from the ledger:

```sql
SELECT COALESCE(SUM(quantity), 0)
FROM inventory_movements
WHERE store_id = ? AND sku = ?;
```

## Fulfillment movements

- The first order transition to `SHIPPED` records one negative movement per distinct SKU.
- The transition to `RETURNED` records the corresponding positive movement.
- `DELIVERED` and `REFUSED` do not create another movement because the stock already left at
  `SHIPPED`.

Order items with the same SKU are aggregated before the movement is written. Fulfillment references
are stable (`order:<order-id>:shipped` and `order:<order-id>:returned`) and protected by a unique
index across store, SKU, reason, and reference.

The order update, order event, and inventory movement are submitted in one D1 batch. If any statement
fails, none of them commit. Replayed courier events are rejected by the webhook inbox and the unique
movement key provides a second idempotency barrier.

## Admin purchase, loss and physical-count operations (#23)

`GET /admin/inventory` shows the first 50 catalogue SKUs and their ledger balances.
Select a SKU (`?sku=...`) for its balance and movement history, 20 rows per page.
The cursor contains SKU, timestamp and ID, validated at the route; timestamp/ID
descending ordering keeps tied timestamps stable. A cursor cannot be reused for a
different SKU. JSON is available with `Accept: application/json`.

`POST /admin/inventory/movements` accepts strict JSON or URL-encoded forms:

```json
{
  "sku": "BIO-OIL-125ML",
  "quantity": 10,
  "reason": "purchase",
  "reference": "invoice-fictional-001-line-1",
  "note": "Facture fictive ; quantité, lot, date et emballage vérifiés."
}
```

- `purchase`: positive quantity.
- `damaged` / `expired`: negative quantity.
- `adjustment`: positive or negative **difference**, never a replacement total.
- Quantity is a nonzero integer in [-100000, 100000]. SKU is bounded to 100 characters.
- Reference is required, bounded to 100 ASCII alphanumeric/dot/underscore/colon/hyphen
  characters; note is required and bounded to 500 characters.
- The request body is streamed with an 8 KiB limit. Duplicate form fields and unknown
  input properties, including a client-supplied actor, are rejected.

Access and Worker JWT verification protect both routes. A write requires same-origin
`Origin` and rejects cross-site fetch metadata; this protects the browser cookie flow
against CSRF. Machine clients must explicitly send the staging origin. All responses,
including errors and redirects, are private/no-store. Notes and actor emails are visible
only to authenticated admins; do not enter customer details or secrets in notes.

The service appends a movement with `user:<verified Access email>`, server timestamp
and UUIDv7. A conditional INSERT requires a product owned by `para-main`, including
inactive SKUs for loss/inspection operations. It performs **no UPDATE of stock**.

### Audit migration and idempotency

Additive migration 0007 adds nullable `operation_reason`, `actor`, `note` and a partial
unique index on (store, reference) for admin movements. Old rows and automatic
shipping/return inserts remain valid and unchanged. Historical actor/note fields may
be null; the page labels them automatic/historical, without inventing an operator.

Expiry is exposed as `expired` via `operation_reason`; its underlying legacy ledger
`reason` is `damaged` (a loss). This preserves the existing reason CHECK without
rebuilding the ledger. Balance calculations ignore reason and still sum signed quantity.

Admin references are stored as `admin:<input reference>`, separate from automatic
`order:...` references. The new unique index makes a reference unique across SKU and
reason within the store. One INSERT arbitrates concurrent writers atomically:

- First success: 201 with movement ID and `duplicate: false`.
- Same reference + same normalized SKU, reason, quantity, note: 200 with original ID
  and `duplicate: true`; original actor and time are preserved, even for another admin.
- Same reference with changed operation: controlled 409, no second movement.
- Unknown SKU: 404; invalid input: 400; invalid actor/origin: 403; database failure: 503.

HTML success uses a 303 redirect. Valid drafts, including their reference, survive
database/conflict error rendering. Retry with the **same** reference after uncertain
network outcomes. A fresh reference intentionally creates a new movement: this is
not a global deduplication algorithm for physical events. Split a multi-SKU invoice
into stable per-line references; entering the same invoice reference for two SKUs is
a conflict, not a second receipt.

### Return inspection decision

The existing RETURNED transition credits the physical ledger immediately. This is
physical stock, **not certified sellable stock**. Before resale, an operator checks
seals, lot and expiry. Good returns require no second positive movement; damaged or
expired returned units require a negative loss movement with an inspection reference
and note. Until inspection, keep the parcel physically separate and do not list it
as sellable. There is no automated quarantine/reservation/inspection-state system
in this ticket; this remains an explicit operational limitation.

Errors in the ledger are corrected by a new signed adjustment with a new reference
and explanatory note; existing rows must not be edited or deleted. Negative balances
remain visible instead of being clamped. Example: purchase +10, ship −2, return +2,
damage −1 yields physical stock 9.

Tests cover actual inventory CHECKs and migration preservation, purchase/loss/count
signs, derived balances, concurrent replay/conflicts, audit preservation, store isolation,
inactive SKUs, pagination, Access, CSRF, body limits, escaping and private errors.
No live database or credential is changed by development tests. Main deployment
applies migration 0007 before deploying the new routes.
