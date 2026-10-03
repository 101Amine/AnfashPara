<!-- docs/contracts/manual-shipment-fees.md -->

# Explicit fees for manual shipments

A manual parcel has no vendor API quote. Its delivery/return fee starts as SQL `NULL`,
meaning **unknown**, not free. Reconciliation classifies it `missing_fee` until an
authenticated human records the amounts. No bank transfer or actual courier booking
is performed by this feature.

GET `/admin/shipments/:shipmentId/fees` shows the French form, linked as **Frais manuels**
in the order queue. POST to that path accepts URL-encoded form fields or JSON:

```json
{
  "deliveryFee": "0",
  "returnFee": "0",
  "reason": "Livraison personnelle sans frais — décision explicite"
}
```

The strings are MAD amounts, with at most two decimal places, converted by the core
money helper to integer centimes. Negative amounts, unknown fields, duplicate form
keys, invalid IDs and bodies above 4 KiB are rejected. Both fees and a 5–300-character
reason are mandatory. There are no zero defaults in the form.

The request requires Cloudflare Access and a verified human JWT, exact same-origin
Origin, and no cross-site Fetch Metadata. Service identities cannot read or write this
route. All responses are private/no-store. Only this store's `SELF-` shipments qualify.

One D1 batch writes the fees and an `order_events` audit entry with reason
`manual_fees_recorded`, authenticated actor, previous/new fees and justification.
The order status does not change: this is an audit entry, not a state transition.
A compare-and-swap snapshot guard aborts the entire batch if fees/order status changed.
Audit insertion failure cannot leave unaudited fees behind. No migration is needed.

Known fee components cannot be overwritten. Identical amounts return
`200 { "duplicate": true }` in JSON without another audit entry; changed known amounts
or previously settled orders with missing fees return 409. A future correction workflow
must explicitly account for already-approved settlement reports; this endpoint is not
a general financial editor. HTML success redirects back to the form.

Recording fees does **not** settle an order. Reconciliation still requires delivery,
matching CSV components, matching receipt amount and explicit import approval.
Tests cover real migration constraints, audit rollback, races, explicit zero,
decimal arithmetic, locks, authentication, origin checks, validation and private HTML.

## Browser form compatibility

The Worker now uses `Referrer-Policy: same-origin`. Hono's default `no-referrer`
can cause navigation POSTs to send `Origin: null`, which our strict admin forms reject.
The changed policy preserves same-origin form provenance but sends no referrer to
external sites; null/foreign origins remain forbidden. See the
[Hono header defaults](https://hono.dev/docs/middleware/builtin/secure-headers) and
[Fetch's Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header).
Confirmation/parcel POSTs also reject explicit foreign origins and cross-site metadata;
existing authenticated non-browser calls without an Origin remain compatible.
