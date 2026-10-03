# Create parcel workflow

`POST /admin/orders/:orderId/parcel` is protected by Cloudflare Access and the Worker's JWT
verification. The actor comes from the verified Access identity; the request cannot choose it.

## Rules

1. Only an order in `CONFIRMED` can create a parcel.
2. One `(store_id, order_id)` can have only one shipment.
3. The order UUID is also the courier idempotency key.
4. The courier call runs before local writes. A courier error leaves the order `CONFIRMED` with no
   shipment, so the operator can retry.
5. After courier success, D1 atomically stores the shipment and state-machine events:
   - courier status `created`: `CONFIRMED → PACKED`;
   - courier status `picked`: `CONFIRMED → PACKED → SHIPPED`.
6. If the D1 transaction fails after the courier accepted the request, retrying uses the same
   idempotency key and must return the same courier parcel.

## Manual-first configuration

`COURIER_MODE=manual` is the default. It requires no credentials and creates a deterministic internal
tracking number. `COURIER_NAME=self-delivery` is suitable when an owner delivers the first parcels.

Manual shipment statuses must be updated by an operator; the adapter does not invent tracking events.

## Optional API secrets

When `COURIER_MODE=api`, the Worker adapter reads `COURIER_API_URL`, `COURIER_ACCOUNT_ID`,
`COURIER_API_TOKEN`, and `COURIER_NAME` from bindings. Real credentials belong in Wrangler secrets and are never committed.
The token and account identifier are sent as headers, not persisted in D1 or included in application
errors.
