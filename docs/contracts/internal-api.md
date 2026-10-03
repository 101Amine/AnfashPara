<!-- docs/contracts/internal-api.md -->

# Internal storefront and fulfillment contracts

## Decision

The storefront, checkout, API and admin are first-party components in this monorepo. The browser
creates orders through our Hono API; it does not impersonate a signed third-party webhook.

```text
Storefront client --POST /api/orders--> Hono --transaction--> D1
Admin client --POST /admin/...-------> Hono --transaction--> D1
```

## Order creation

`POST /api/orders`

Required headers:

- `Content-Type: application/json`
- `Idempotency-Key: <client-generated unique value>`

There is no signature header. A signing secret embedded in browser JavaScript would be public and
would provide no authentication. The implemented boundary instead uses strict Zod validation, a
16 KiB body limit, a per-IP burst limit and server-side price lookup. The in-Worker burst limiter is
best-effort per Worker isolate; add a Cloudflare edge rate-limit rule before a larger public launch.

The request contains:

- customer: `name`, `phone`, `city`, `address`, optional `note`;
- items: server-known `sku` and positive integer `quantity`;
- optional attribution: `utmSource`, `utmCampaign`, `utmContent`.

The request never contains trusted prices, COGS, totals, status, store ID or customer counters.
Those values are calculated or assigned by the server.

The original ticket's "external event ID" is replaced by the `Idempotency-Key`. Reusing a key with
the same request must return the original result; reusing it with a different request must fail.

The key is stored in `webhook_inbox` under source `public-api`; only its SHA-256-derived value is
used as the order's external ID and order-number seed. The normalized validated request is stored as
the idempotency payload. A replay with that same payload returns HTTP `200`, `duplicate: true` and
the original order result. A different payload returns HTTP `409 idempotency_conflict`.

For a first request the API returns HTTP `201`:

```json
{
  "duplicate": false,
  "orderId": "0199a001-1000-7000-8000-000000000001",
  "orderNumber": "PARA-63CDA17FA3E2B740",
  "status": "CONFIRMING",
  "codAmountCentimes": 28700,
  "currency": "MAD"
}
```

The route converts the validated request to the existing order-ingestion contract and submits one
D1 batch. That transaction writes the idempotency inbox row, customer upsert, order, frozen-price
items, `NEW → CONFIRMING` event and confirmation outbox row. A unique inbox constraint resolves two
concurrent deliveries safely: one wins, the other loads and returns the committed result.

Shipping is currently `0` because no first-party delivery-zone pricing rule exists yet. It is
assigned by the server and is never accepted from the browser.

Fixtures:

- `apps/api/test/fixtures/contracts/order-create.request.json`
- `apps/api/test/fixtures/contracts/order-create.response.json`

## Manual/test fulfillment

Until a physical carrier is selected, authenticated admins create and update shipments through our
own API. Cloudflare Access authenticates these `/admin/*` requests.

The canonical shipment statuses are:

1. `created`
2. `picked`
3. `in_transit`
4. `out_for_delivery`
5. `delivered`
6. `refused`
7. `returned`
8. `lost`

Every status update carries its own `eventId` for idempotency and an ISO timestamp. These are our
domain statuses; no provider-specific raw status mapping exists yet.

Fixtures:

- `apps/api/test/fixtures/contracts/shipment-create.request.json`
- `apps/api/test/fixtures/contracts/shipment-create.response.json`
- `apps/api/test/fixtures/contracts/shipment-status-events.json`

## Missing or unreliable fields

| Field               | Reliability                     | Decision                                                              |
| ------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Phone               | User-entered and often spaced   | Normalize and validate Moroccan mobile format server-side             |
| City                | User-entered unless constrained | Replace with an allowed-city identifier when delivery zones exist     |
| Address             | Free text                       | Required but operationally unverified until confirmation              |
| Customer name       | Free text                       | Display value only; do not use as identity                            |
| Note                | Optional free text              | Sanitize for display; never interpret as instructions to backend code |
| UTM values          | Optional and client-controlled  | Useful attribution metadata, never authorization or billing evidence  |
| SKU                 | Client-controlled               | Must exist and be active; server loads price and COGS                 |
| Quantity            | Client-controlled               | Positive bounded integer; server checks availability                  |
| Idempotency key     | Client-generated                | Unique per checkout attempt; bind it to a request hash                |
| Shipment event time | Admin/test supplied             | Store received time separately; reject malformed/future-skewed values |
| Tracking number     | Manual during this phase        | Enforce uniqueness per store                                          |

## Credentials and secrets

The fixtures contain fictional names, addresses, IDs, tracking numbers and `.test` URLs. They do
not contain tokens, API keys, authorization headers, production email addresses or real customer
data. Future secrets belong in Cloudflare secrets or local `.dev.vars`, never in fixtures or Git.

## Deferred provider questions

If a carrier is integrated later, create a separate provider adapter and capture its real signature
header, event ID, raw status names and retry behavior from official documentation. Do not change
the internal order or shipment contract to mirror a provider payload.
