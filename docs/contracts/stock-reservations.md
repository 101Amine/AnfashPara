# W4-02 — Stock reservation decision

Decision date: 2026-11-22. Policy accepted for the initial manual/COD operation:
**no automatic expiry; release through an authorized cancellation**.

Status: policy approved; W4-03 storage, atomic checkout enforcement and reservation
lifecycle implemented locally and tested. Enforcement is disabled by default and is
NOT deployed. Reviewed backfill and admin visibility are implemented locally;
actual legacy-data reconciliation and staging proof remain.

## W4-03 foundation (not activation)

Migration `0008_stock_reservations.sql` adds the reservation table and an order/store
unique parent index without rewriting existing tables or backfilling orders. Composite
foreign keys keep order and product ownership in the same store. One row per
store/order/SKU retains immutable acquisition details and, after closure, immutable
terminal actor/time/reason. Custom SQLite triggers require an initial active state,
protect acquisition/terminal history and reject deletion. These triggers are maintained
in the SQL migration, not represented in Drizzle snapshots: future table rebuilds must
preserve them. Local reset drops the child table before its parents.

The internal `readStockAvailability()` read model calculates physical/reserved/available
without clamping negative shortfalls. No public response or admin route uses it yet.
Neither the table alone nor this read query guards stock allocation. The shared ingestion
guard below enforces available quantities. Running legacy reconciliation and staging
verification remain required before activation.

## W4-03 atomic ingestion (disabled pending rollout verification)

Both `POST /api/orders` and signed `POST /api/webhooks/orders` pass a server-controlled
option into the shared ingestion service. Only the exact Worker binding value
`STOCK_RESERVATIONS_ENABLED=true` enables it. No environment in Wrangler enables it;
request bodies cannot opt in or out. Do not set it on staging or production yet.

Inside the existing D1 batch, after order/items insertion, one reservation per SKU is
inserted. Its SQL statement compares the requested quantity against the store/SKU's
physical movement sum minus active reservations. When insufficient, SQL supplies zero
to the named `stock_reservations_quantity_valid` CHECK. That constraint failure aborts
the entire batch. It must not be replaced with a conditional INSERT that silently inserts
zero rows, or a separate availability pre-read followed by an unconditional write.

The transaction includes inbox, customer upsert, order, items, holds, order event and
outbox. No partial acceptance or physical movement occurs. The inbox unique insert
runs first, so a concurrent duplicate loses there before reaching the stock guard and
returns the original receipt even when remaining availability is zero. Public retries
with a changed payload still return `idempotency_conflict`.

Both endpoints return HTTP 409 on insufficient stock:

```json
{
  "error": {
    "code": "insufficient_stock",
    "message": "One or more products have insufficient stock"
  }
}
```

This response exposes no internal quantities, COGS or SQL. A rejected transaction leaves
no inbox row, so the same request can be retried after replenishment. Unexpected database
failures retain the existing controlled 503 response. HTTP schemas reject repeated SKUs;
internal service calls aggregate repeated quantities into one hold.

Integration tests run the full migration chain against disposable local D1 and cover
competing last-unit requests, concurrent same-key retries, cross-endpoint allocation,
multi-item rollback, later audit failure, quantity checks, store isolation, negative stock,
closed-hold replay and disabled behavior. Live staging proof remains a later rollout step.

## W4-03 reservation lifecycle

Migration `0009_reservation_lifecycle.sql` adds an `AFTER INSERT` trigger on
`order_events`. A transition into CANCELLED releases active holds; a transition into
SHIPPED consumes them. It records the event's actor, timestamp and reason. Closed
holds are never updated again. Events for confirmation, callbacks, packing, refusal,
delivery and return do not close or recreate holds.

This hook runs inside the existing service transaction, not as a background task.
Cancellation commits the state, confirmation attempt, event and release together.
Shipping commits the state, event, consumed hold and negative inventory movement
together. Failure of any statement rolls everything back. The services still call
`transition()` to authorize state changes; the trigger handles reservation bookkeeping.
It does not make otherwise-illegal transitions legal.

Manual shipment updates, webhook/poll status updates that skip intermediate states,
and immediate courier pickup all write the SHIPPED event and therefore consume holds.
REFUSED does not restock; RETURNED adds the existing idempotent positive movement
without resurrecting the consumed hold. The closure trigger is deliberately independent
of `STOCK_RESERVATIONS_ENABLED`: stopping new holds must not strand existing holds.

Confirmation state writes compare the previously read status and no-answer count
inside the transaction. A race aborts the entire batch and returns HTTP 409
`confirmation_conflict`; the operator must reload before retrying. No automatic retry
is performed that could silently count another contact attempt.

Legacy orders with no holds continue to use the existing lifecycle. This compatibility
does not replace reconciliation: every open obligation must be reviewed/backfilled
before acquisition is enabled. Direct SQL state updates without order events bypass
the hook and are not a supported operational workflow. Preserve this custom trigger
when rebuilding `order_events`; Drizzle snapshots do not represent triggers.

Tests exercise cancellation/replay, third no-answer, competing cancel/confirm,
packing, immediate pickup, courier failure, manual shipping/replay, concurrent pickup,
webhook/poll skipped transitions, refusal/return and rollback after closure or stock
movement failure against the real migrations.

## Problem and goals

Checkout currently accepts active SKUs without reserving inventory. Two customers
can therefore order the last unit. The implementation must accept at most one of
those competing orders, preserve safe retries, and keep physical inventory auditable.

As a customer, I want an accepted order to hold my items while the shop contacts me.
As an operator, I want cancellation to release that hold without inventing a physical
stock movement, and shipping to consume it without subtracting stock twice.

## Definitions (per store and SKU)

- **Physical stock:** the sum of `inventory_movements.quantity`. This is the ledger's
  on-hand balance, not an editable stock total. Purchases add; shipments subtract;
  actual returns add; audited loss/count corrections adjust the ledger.
- **Reserved stock:** quantities held by accepted, not-yet-shipped orders. A hold
  is separate from physical movements and has an auditable terminal outcome:
  released on cancellation or consumed on shipment.
- **Available stock:** physical stock minus active reserved stock. New orders may
  reserve only quantities that fit in this balance.

Adding to a cart or viewing a product does not reserve stock. Cached catalogue data
is never authority to accept an order. Repeated item lines must be aggregated by SKU.

## Lifecycle rules

| Operation/state                              | Reservation effect                                      | Physical movement                  |
| -------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| Successful order ingestion, NEW → CONFIRMING | Acquire all item quantities atomically                  | None                               |
| CONFIRMING / NO_ANSWER, including callback   | Keep the existing hold                                  | None                               |
| CONFIRMED / PACKED                           | Keep the existing hold; do not reserve again            | None                               |
| Legal transition to CANCELLED                | Release the hold once                                   | None                               |
| Third no-answer → CANCELLED/no_answer        | Release the hold once in the cancellation transaction   | None                               |
| PACKED → SHIPPED                             | Consume the hold once                                   | Negative item quantities, once     |
| DELIVERED / SETTLED                          | No active hold remains                                  | None                               |
| REFUSED                                      | No release or restock: parcel is still outside the shop | None                               |
| REFUSED → RETURNED                           | Do not recreate the old hold                            | Positive returned quantities, once |

Both public checkout and signed order ingestion must enforce the same rules.
Failed parcel creation must leave the existing reservation intact and the order retryable.
Receipt of a return follows the current restock workflow; damaged/expired items require
an audited loss adjustment before they are offered again. Partial returns and quarantine
are outside this decision, not silently supported.

### Cancellation boundary

The existing state machine permits cancellation from CONFIRMING and NO_ANSWER,
not from CONFIRMED or PACKED. This decision does not add new transitions or actors.
Do not release stock while leaving an order in a fulfillable state. A requested
post-confirmation cancellation needs a separately approved, audited workflow before
it can be supported; do not work around it by editing stock or deleting the order.

## Expiry and daily operation

There is no 24-hour or 48-hour deadline and no scheduled automatic release. Age alone
does not change an order or reservation. Callbacks and retries neither add holds nor
introduce an expiry. The third no-answer rule still cancels based on recorded attempts,
not elapsed time.

The shop operator must review CONFIRMING and NO_ANSWER orders daily, contact customers,
and explicitly confirm, call back, or cancel using the admin workflow. Review stranded
CONFIRMED/PACKED orders as well. Forgotten orders can block stock indefinitely: that
is the acknowledged tradeoff of avoiding automatic cancellation during manual launch.

Before public launch, show operators physical, reserved and available quantities and
the orders holding them. A hold must never be invisible merely because a customer has
not answered. Revisit timed expiry if the queue cannot be reviewed reliably; that
requires a new business decision, not an undocumented cron change.

## Atomicity and idempotency requirements (implementation P0)

1. Check and acquire stock with database-enforced guards in the same atomic D1 write
   as inbox/idempotency, customer, order, items, state event and outbox effects.
   Reserve every item or none; insufficient stock must produce a controlled error
   without partially creating an order, customer effects or holds.
2. An application pre-read is not the final guard. Two requests can both read one
   available unit before either writes. The committed database operation must ensure
   only one can acquire it; exact SQL/schema mechanics belong to implementation.
3. Same checkout key and canonical payload returns the original receipt with no new
   hold, even if availability later reaches zero or the original order is cancelled.
   Replaying a cancelled order does not resurrect it. Changed payload with the same
   key remains a conflict. A new key is a new request subject to current availability.
4. A duplicate signed event has no additional effect. Keep existing delivery
   deduplication and add reservation uniqueness scoped to store/order/SKU.
5. Cancellation must atomically commit the guarded state change, confirmation attempt
   where applicable, order event and release. Shipment must atomically commit its
   guarded state/events, hold consumption and physical movement. Roll back all effects
   if any step fails; concurrency/replay must not create a second release or movement.
6. Persist an audit trail of acquisition, release and consumption. Do not delete holds
   to hide history, rewrite physical stock totals, or trust browser-supplied availability.

## Worked examples and acceptance checks

| Scenario                                                     | Expected result after implementation                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Physical 1, reserved 0; two concurrent orders request 1 each | One order succeeds; other receives a controlled stock error. Physical 1, reserved 1, available 0. |
| Winning unconfirmed order is cancelled                       | Physical 1, reserved 0, available 1. Repeating cancellation cannot release twice.                 |
| Same successful checkout is retried                          | Same receipt and one hold; no second order/event/outbox effect.                                   |
| One item is available, another requested item is not         | Entire order fails; no partial holds or order writes.                                             |
| First and second no-answer; then third                       | First two keep hold; third cancels and releases it atomically.                                    |
| Unconfirmed order is still open after 72 hours               | Hold remains; daily operator review is required.                                                  |
| Physical 5, reserved 2; the two reserved units ship          | Physical 3, reserved 0, available 3. Available does not drop twice.                               |
| That parcel is refused, then actually returned               | Refusal leaves physical 3; return restores physical 5, reserved 0. Replay does not restock again. |
| Audit insert or stock guard fails during a transition        | State, reservation and ledger all retain their previous committed values.                         |

## Rollout dependencies and non-goals

- Existing CONFIRMING, NO_ANSWER, CONFIRMED and PACKED orders need a deliberate
  reservation backfill/reconciliation before enforcement. Audit staging seeds and
  synthetic orders too. If obligations exceed physical stock, resolve the discrepancy;
  do not silently drop old orders or treat their stock as available to new orders.
- An audited loss/count correction can reveal physical stock below reservations.
  Preserve that truth, block further allocation for the affected SKU, and surface the
  shortfall for operator resolution. Do not clamp internal balances to conceal it.
- All accepted ingestion paths and fulfillment paths must be covered before enabling
  the feature. Prove concurrent last-unit behavior, transaction rollback and replay
  safety in integration tests, then rehearse on staging before production activation.
- No schema migration, endpoint change, reservation timer, payment integration,
  frontend countdown or production deployment is included in W4-02.
- Abuse protection matters before exposing indefinite holds publicly: different keys
  can intentionally exhaust stock. Idempotency alone does not stop that. Stronger
  checkout abuse controls remain a launch-readiness dependency.

## Next ticket and open implementation questions

Next: review legacy orders using the admin workflow below, then rehearse on staging.
The tools are implemented locally; this does not prove existing data is ready for
activation. The operator must resolve legacy stock
shortfalls and confirm the daily review routine before activation.

## W4-04 admin stock and reviewed backfill

`GET /admin/inventory/reservations` is protected by the existing Access/JWT middleware.
It returns a French HTML page or JSON with `Accept: application/json`. Responses are
private/no-store. Service identities cannot operate this human review workflow.
The inventory ledger links to it. No customer names, phones, COGS or private stock
fields are added to public catalogue responses.

The stock table includes physical, active reserved, available, outstanding unreserved
open-order quantities and the projected balance after regularization. Negative values
are preserved and flagged. Stock pages use the last SKU as `after` (50 per page);
open-order pages use the last UUID as `ordersAfter` (20 per page). Follow all pages;
an empty page is not a global readiness certification. Orders with missing items or
partial/mismatched/closed holds are flagged for manual investigation, not repaired
automatically. This view is operational guidance, not an exhaustive database audit.

Selecting `?order=<UUID>` previews all aggregated item quantities and current balances.
Only open CONFIRMING/NO_ANSWER/CONFIRMED/PACKED orders with zero existing holds,
1–50 SKU lines and adequate stock can be backfilled. The operator chooses each order
deliberately; the system does not choose which customer wins a shortage.

`POST /admin/inventory/reservations` accepts `orderId` and the preview's `token` as
JSON or form data. Same-origin requests and a human admin identity are required.
The body is limited to 4 KiB. The token fingerprints the reviewed snapshot; it is not
an authentication credential. Changed previews return 409 `review_changed`; blocked
ones return 409 `review_blocked`. Refresh and review again, never silently accept changes.

Apply rechecks status, item quantities, physical stock, reserved stock and absence of
holds inside the D1 transaction. It inserts the holds and an `order_events` record
with unchanged status, admin actor and reason `reservation_backfilled`. Physical stock,
order status, customer data and outbox remain unchanged. Any failure rolls back all
holds and audit. No additional schema migration is required beyond 0008 and 0009.

The exact same order/token can be retried concurrently or after cancellation/shipment:
the persisted audit returns `duplicate: true` without recreating holds. A new review
cannot overwrite existing reservation history. Acquisition actor is the reviewing admin.

Rollout: deploy migrations and code with acquisition disabled, inspect every page,
resolve shortages/partial records, review and backfill valid legacy orders, recheck
balances, and run staging lifecycle tests before enabling acquisition. These local
changes do not apply any backfill or configuration to staging or production.

Automatic expiry, post-confirmation cancellation and damaged-return quarantine remain
separate future decisions. W4-02 is complete when these policy rules and examples are
reviewable; it is not evidence that overselling protection is already deployed.

Code references: `packages/core/src/orderStateMachine.ts`,
`apps/api/src/modules/order-ingestion/orderWebhook.service.ts`,
`apps/api/src/modules/confirmation/confirmation.service.ts`, and
`apps/api/src/modules/inventory/inventory.service.ts`.
