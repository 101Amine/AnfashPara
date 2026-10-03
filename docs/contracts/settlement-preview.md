# Settlement CSV preview — Week 3, issue #19

The admin page at `/admin/settlements` reads a CSV file and displays what it contains.
The separate [reconciliation workflow](./settlement-reconciliation.md) can now match and import an
explicitly approved preview; the original preview endpoint remains read-only.
It does not import the file into D1, match shipments, change orders, or confirm receipt of money.
This also works for a fictional self-delivery statement while no courier has been selected.

## Request lifecycle

```text
Operator chooses CSV in /admin/settlements
  → POST /admin/settlements/preview (multipart field: file)
  → Cloudflare Access authenticates the operator
  → Worker middleware verifies the Access JWT
  → upload handler bounds bytes and decodes UTF-8
  → pure core parser validates columns and each row
  → money.parse() converts MAD text to integer centimes
  → money.add() calculates exact totals of valid rows
  → Hono returns French HTML or JSON
```

The HTTP handler manages authentication and uploading. The parser in `packages/core` is a pure
function: the same CSV string always produces the same result. It does not need Cloudflare,
a database, a clock, or network access. That makes it easy to test and reuse in reconciliation.

## Accepted file format

CSV is UTF-8, with an optional BOM. Comma and semicolon delimiters, LF/CRLF line endings,
quoted fields, embedded delimiters, escaped double quotes, and multiline quoted fields are supported.
Multiline notes are allowed in extra columns; required tracking/status fields cannot contain controls.
Empty physical lines are ignored. Rows containing delimiters but no values are rejected.

| Internal column | Accepted French alias | Meaning |
| --- | --- | --- |
| tracking_number | Numéro suivi | Parcel tracking reference, nonempty, maximum 128 characters |
| cod_collected | Montant encaissé | COD reported as collected, in MAD |
| delivery_fee | Frais livraison | Reported delivery fee, in MAD |
| return_fee | Frais retour | Reported return fee, in MAD |
| net_amount | Montant net | Reported net payout for the line, in MAD |
| courier_status | Statut | Raw courier status, nonempty, maximum 120 characters |

Headers ignore case, accents, and spaces/hyphens versus underscores. Columns may be reordered.
Extra columns are ignored; their contents are not displayed or retained in the result.
Missing columns and duplicate headers, including aliases of the same column, reject the file.

Amounts must be nonnegative plain decimal strings with at most two decimal places. `250`,
`250.5`, `250.50`, and quoted `"250,50"` are valid. Decimal commas do not need quotes in a
semicolon-delimited file. Currency suffixes, grouping separators, signs, exponents, blank
amounts, and extra decimal places are rejected. Values are parsed with integer/BigInt money
helpers; floating-point MAD values are never added, multiplied, or rounded for this preview.
An individual or total amount outside JavaScript's safe integer-centime range is rejected.

## Limits and responses

- Maximum file size: 1 MiB (1,048,576 UTF-8 bytes).
- Maximum data records: 1,000, excluding the header and blank physical lines.
- Maximum complete multipart request: file limit plus 64 KiB for upload overhead.
- The handler limits the actual stream, even without an accurate Content-Length.
- Exactly one file in field `file`; other form fields are rejected.
- Only `.csv` files are accepted. File extension/MIME never replaces content validation.

`GET /admin/settlements` renders the private French form. Submit it as a browser upload,
or send multipart with `Accept: application/json` for the normalized contract:

```json
{
  "valid": true,
  "rowCount": 1,
  "invalidRowCount": 0,
  "rows": [{
    "line": 2,
    "trackingNumber": "SELF-DEMO-001",
    "rawCourierStatus": "delivered",
    "codCollectedCentimes": 25000,
    "deliveryFeeCentimes": 3000,
    "returnFeeCentimes": 0,
    "netCentimes": 22000
  }],
  "errors": [],
  "totals": {
    "codCollectedCentimes": 25000,
    "deliveryFeeCentimes": 3000,
    "returnFeeCentimes": 0,
    "netCentimes": 22000
  }
}
```

Valid preview: 200. Row validation failures: 422 with `valid: false`, physical CSV line numbers,
French messages, valid rows, and totals of those valid rows only. An invalid file must not be
treated as an importable statement. Structural failures return 422 with an `error` code/message.
Malformed upload/UTF-8: 400. Oversize: 413. Unsupported request or file type: 415. Foreign Origin: 403.
The existing Access middleware controls unauthenticated requests before file parsing.

HTML previews include the same errors and totals, escaped tracking/status/filename values,
a mobile layout, and a horizontally scrollable results table. All successful and validation/error
responses from these handlers use `private, no-store, max-age=0` and vary on Accept and Access identity.
File contents are not logged, persisted, or sent to an external parsing service.

## Assumptions and unresolved courier quirks

These columns are our internal contract, not a verified production courier export. Only fictional
fixtures are committed under `packages/core/test/fixtures/settlements`.

- Obtain a sanitized real statement before adding a courier-specific adapter or XLSX.
- Confirm whether money is MAD text or already centimes; guessing would multiply amounts by 100.
- Confirm negative payouts, refunds, taxes, adjustments, and grouped fee rows. Current amounts are
  nonnegative to agree with the existing settlement schema; negative adjustments need a deliberate model.
- Confirm whether one tracking number may legitimately occur more than once. The preview preserves
  duplicates; matching/reconciliation must decide what they mean.
- Blank return fees must currently be explicit zeroes. We do not assume that an absent fee means zero.
- Unknown status strings are preserved, not mapped to order states.
- Net amount is the reported value. Differences from COD minus fees are reconciliation questions;
  the preview does not silently correct them or assert that they are valid financial results.
- The settlement line table combines fees in `fee_centimes`. Reconciliation combines reported
  delivery and return fees there and preserves their separate values in the immutable report JSON.
- Statement reference, period, courier identity, bank receipt, and expected fees are not supplied
  by this parser. Reconciliation asks for courier, statement reference, period and confirmed receipt
  amount separately, then loads expected fees from the shipment.

## Why parsing and settling are separate

A readable file proves only that its fields can be interpreted. A line saying `delivered` does
not prove it belongs to our shipment, that the fee is correct, or that the money reached us.
Preview lets the operator catch bad columns and values without changing business state.
The reconciliation workflow matches the shipment, compares expected amounts, preserves exceptions,
and uses the authorized reconciliation actor for an approved exact DELIVERED → SETTLED transition.

No D1 migration is needed for this ticket. Parser unit tests exercise formats, exact arithmetic,
row errors and limits. HTTP tests exercise Access protection, multipart handling, private caching,
HTML escaping and D1 sentinels showing that neither orders nor financial tables change.
