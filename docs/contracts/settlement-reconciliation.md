# Settlement reconciliation — Week 3, issue #20

## The four things we must not confuse

- **Delivery status:** the parcel reached its customer (`DELIVERED`). It says nothing about payout.
- **Expected payout:** the immutable order COD minus the applicable, saved courier fees.
- **Statement payout:** what the courier CSV says. This can contain mistakes or unknown parcels.
- **Bank/cash receipt:** money actually received. An admin verifies it outside the application,
  enters the amount in MAD and explicitly approves the import. There is no bank API verification.

For self-delivery, use courier `manual` and your own unique statement reference. Do not invent
a courier integration or production credentials. The existing `sendit` seed is fictional.

## Request lifecycle

```text
/admin/settlements/reconcile (French form)
  → Cloudflare Access + Worker Access JWT verification
  → bounded UTF-8 multipart upload (or bounded JSON)
  → pure CSV validation (no invalid rows accepted)
  → D1 lookup: store + courier + tracking number
  → pure reconcileSettlement(): expected amounts, classifications and totals
  → read-only report + approval fingerprint
  → admin verifies receipt and explicitly approves
POST /admin/settlements/import
  → validate metadata and approval
  → reparse CSV, reload D1, reject changed preview
  → one D1 batch transaction:
      statement + immutable report + importing admin
      → guarded settlement lines
      → transition(DELIVERED, SETTLED, actor=reconciliation)
      → order updates + audit events
  → /admin/settlements/reports/:id (saved report)
```

The parser and reconciliation rules live in `packages/core`; they do not depend on Hono,
Cloudflare or database APIs. Hono validates HTTP input and maps controlled errors. The service
loads authoritative order/shipments and builds parameterized D1 statements.

## HTTP contract

GET `/admin/settlements/reconcile` shows the upload form. POST to the same path previews.
POST `/admin/settlements/import` approves and persists. GET `/admin/settlements/reports` lists
the 30 most recent statements; GET `/admin/settlements/reports/:id` shows a store-scoped report.
All are Access/JWT-protected, private/no-store and vary on Accept and Access identity.

Preview fields, in JSON or multipart:

```json
{
  "courier": "manual",
  "statementReference": "SELF-2026-10-03-001",
  "periodStart": "2026-10-01",
  "periodEnd": "2026-10-03",
  "amountPaid": "220.00",
  "source": "tracking_number,cod_collected,delivery_fee,return_fee,net_amount,courier_status\nSELF-001,250,30,0,220,delivered"
}
```

Alternatively, multipart `file` contains a single `.csv` file, replacing `source`. UTF-8,
1 MiB file, 1,000 row and actual request-stream limits from the parser ticket still apply.
Dates must be real calendar dates and ordered. Courier/reference max 128 characters;
they are exact identifiers, not case-insensitive fuzzy matches. Money is plain, nonnegative
MAD text with at most two decimals, converted to safe integer centimes.

Preview JSON returns `{report, approval, contentHash}`. Import resends the same fields plus
`approval` and `confirmed: true` (multipart string `true`). Client actor, expected amounts,
classification and report fields are rejected. The service always supplies the reconciliation
actor, and records the authenticated admin email in the statement and event payload.

200 preview/duplicate; 201 new import; 400 malformed body/UTF-8; 403 foreign Origin;
413 oversized request; 415 unsupported media type; 422 invalid metadata/CSV/approval;
409 stale preview, changed statement reference/content or receipt mismatch;
503 unavailable database/write failure. Internal SQL errors and financial payloads are not logged
or exposed. Same-origin browser forms need both Access authentication and explicit approval;
the digest is a change detector, **not an authentication token**.

## Arithmetic and operational decisions

Amounts never use floating-point MAD arithmetic or rounding. `money.parse/add/sub` operate in
integer centimes with safe-range checks. Thus 100 centimes is exactly 1 MAD, not a rounding tolerance.

Delivered: expected COD = `orders.cod_amount_centimes` (already includes customer shipping);
expected fees = saved delivery fee, with zero return charge. A quoted return fee is not charged
on a successful delivery. For refused/returned diagnostic rows, expected COD is zero and
expected fees include delivery + return quotes; verify this rule against a future courier contract.
Negative expected payout can be displayed, but negative CSV adjustments remain unsupported.
Refused/returned orders never become SETTLED in this workflow.

Classification priority:

1. `duplicate`: all repeated tracking rows, already matched shipments, or SETTLED orders.
2. `unmatched`: no shipment under this store and courier.
3. `status_conflict`: order/normalized shipment/CSV status are not all delivered.
4. `missing_fee`: applicable expected fees are unknown; never silently treat null as zero.
5. `variance_over_100`: absolute reported-net minus expected-net exceeds 100 centimes.
6. `variance`: any nonzero net difference OR incorrect COD/delivery/return components.
7. `exact`: delivered state and every financial component agrees.

Only `exact` rows settle. An offsetting wrong COD and wrong fee still cannot pass. CSV delivery
aliases currently accepted are `delivered` and `livré` (case/accent insensitive); unknown statuses
remain visible exceptions, not guessed mappings.

Receipt must exactly equal the full statement net total before import. Exceptions are stored for
review but never settled. Total expected net counts each known shipment once; unknown expectations
are omitted and labeled as such. Statement totals retain all CSV rows, including duplicates.

The old line-status schema stays compatible: matched=exact, fee_mismatch=monetary variance,
unmatched=other exceptions. The complete detailed classification, separate reported fees, signed
variance, snapshots and totals are preserved in the immutable statement `report_json`.

## Atomicity, concurrency and idempotency

Identity is `(store, courier, statementReference)` with the existing database unique index.
The canonical parsed rows and metadata are SHA-256 fingerprinted. Same identity/content returns
the stored report without another line/event/transition; changed content is a conflict. Keep the
reference stable on retry. Using a new reference cannot re-settle an already matched shipment.

Preview fingerprint also binds authoritative statuses/COD/fees/previous matching. Import reloads
and compares it. In-transaction line insertions assert that each shipment snapshot still matches,
or that an unmatched tracking still does not exist. A stale snapshot forces a NOT NULL violation
and full rollback. All guards execute before updating any orders. Database uniqueness handles
racing imports. No blanket `ON CONFLICT IGNORE` masks errors.

Statement, lines, order state and events share one batch so we cannot claim money received while
losing its audit event, or leave financial rows after a failed order write. D1's transactional batch
guarantee is documented in [Cloudflare's D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Migration 0005 adds nullable content hash, report JSON and importing admin, without rebuilding or
deleting existing statements/lines. Legacy seeded statements are read-only reports: the wrong-fee
line is shown as an exception using its stored expected fee. Missing original fields are not guessed.
Legacy references cannot be reimported as if newly approved.

## Tests and limitations

Core tests cover exact amounts, ±1/100/101-centime boundaries, offsetting discrepancies, duplicates,
unknown fields/statuses, quotes, returns and invalid input. Worker tests use actual migrations,
CHECKs, foreign keys, uniqueness, racing imports, stale guards and injected event-write failures.
They verify no partial writes, unchanged orders for exceptions, private responses, escaped HTML,
Access rejection, legacy migration preservation and browser multipart approval.

No bank integration, courier contract adapter, automatic dispute, accounting export, exception
resolution action or production deployment is included. Review a real sanitized courier statement
before broadening aliases, fee rules or negative adjustment support.
