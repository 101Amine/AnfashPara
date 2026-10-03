# Manual shipment status

An operator uses the mobile French queue at `/admin/orders` for parcels created by the
ManualCourierClient. Its reserved `SELF-` tracking prefix identifies these parcels; changing
the global courier mode later does not change how an existing parcel is managed.

## HTTP contract

`POST /admin/orders/:orderId/shipments/:shipmentId/status`

Cloudflare Access and Worker JWT verification run before the handler. Both IDs must be UUIDs
and belong to the same shipment/order in `para-main`. The request is a strict JSON object
or a browser form with exactly one field:

```json
{ "action": "picked" }
```

| Current order | Action    | New order status | Queue label     |
| ------------- | --------- | ---------------- | --------------- |
| PACKED        | picked    | SHIPPED          | Remis / Expédié |
| SHIPPED       | delivered | DELIVERED        | Livré           |
| SHIPPED       | refused   | REFUSED          | Refusé          |
| REFUSED       | returned  | RETURNED         | Retourné        |

The server chooses the actor, timestamps, raw status and event ID. A submitted actor,
unknown field, or SETTLED action is rejected. Browser forms require a same-origin Origin
header; JSON clients still need a valid Access JWT and cannot supply a foreign Origin.

JSON success is `200 { "duplicate": false, "orderStatus": "SHIPPED" }`. Replays return
`200 { "duplicate": true }`. Errors use `{ "error": { "code", "message" } }` with 400
for invalid input, 403 for origin rejection, 404 for missing/mismatched IDs, 409 for
illegal transitions or API-managed parcels, and 503 for database failures.

Browser submissions receive French success/error HTML with a return link. All responses
use `Cache-Control: private, no-store, max-age=0`.

## One domain service and one transaction

```text
Admin button → Access JWT → Zod → verified user:<email>
                                      ↓
Courier webhook → HMAC → mapper → synchronizeCourierStatus()
                                      ↓
                              core transition()
                                      ↓
                    atomic D1 batch: inbox + shipment event
                    + shipment + order + order event + counters
                    + inventory movement when required
```

Authentication differs at the entry points. State rules, counters, event history and stock
must agree regardless of the entry point, so both call the same domain service.

Manual actions use a stable `manual:<shipmentId>:<action>` event key in the existing inbox.
The unique inbox index catches concurrent duplicate requests. The batch also checks the
order's original status before committing, so a conflicting concurrent outcome cannot
overwrite a newer decision. An illegal or failed action does not consume its event key.

Shipping inserts a negative stock movement; returning inserts a positive one. Their
existing unique references prevent a second movement. The order event and movement share
the batch: an inventory failure rolls back the status change, events, counters and inbox.
Stock remains the sum of movement quantities.

Courier notifications may infer intermediate steps for missing upstream events.
Admin buttons require each edge explicitly: delivery cannot skip handover, and a return
cannot skip refusal. Manual actions never set SETTLED.

## Verification

D1 integration tests cover authentication, validation, store/ID matching, legal and illegal
paths, repeated and concurrent submissions, rollback on inventory failure, stale-write
conflicts, French form responses and queue actions. Existing courier webhook and polling
tests exercise the same service. No migration or courier credentials are required.
