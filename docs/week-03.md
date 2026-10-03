<!-- docs/week-03.md -->

# Week 3 — understand the backend before designing the frontend

## The honest result

We have a first-party commerce backend on staging, not a launched shop.
Its implemented foundation covers checkout, confirmation, manual parcel handling,
inventory, settlement reconciliation, an operational dashboard and durable background
work. A five-case machine rehearsal now runs without Google clicks.

This does not mean every future backend need is finished. Real notifications, stock
reservation, catalogue/checkout integration and production operations remain deliberate
carryover. Frontend design is paused so we can choose an elegant experience calmly.

## What each technology actually does

| Layer                  | Our technology                   | Plain explanation                                                                  | Familiar comparison                                       |
| ---------------------- | -------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Programming language   | TypeScript                       | JavaScript with compile-time types; not a server or a database                     | Java types, but erased at runtime                         |
| Execution environment  | Cloudflare Worker                | Runs the deployed API when requests or schedules arrive                            | The runtime hosting a Spring app, not a security firewall |
| HTTP framework         | Hono                             | Matches a URL/method, runs middleware and returns JSON or HTML                     | Spring MVC controllers / Express routes                   |
| Input validation       | Zod                              | Checks real runtime input; TypeScript alone cannot validate a customer's JSON      | Bean Validation / DTO validation                          |
| Business rules         | `packages/core`                  | Pure money, phone, transitions, CSV and reconciliation rules                       | Domain services without HTTP/database dependencies        |
| SQL/schema tools       | Drizzle                          | Defines typed schema/migrations and constructs some SQL queries                    | An ORM/query builder, not the database                    |
| Persistent storage     | D1                               | Stores customers, orders and the ledger using SQLite semantics                     | A managed SQL database                                    |
| Admin authentication   | Access + Google + JWT/JWKS       | Google proves identity; Access checks policy; Worker verifies the signed assertion | Login gateway plus API token validation                   |
| Development/deployment | Wrangler                         | Runs local Workers, applies D1 migrations and deploys                              | Platform CLI rather than application code                 |
| Testing                | Vitest + Cloudflare test runtime | Exercises domain rules and Worker routes with test D1                              | Unit and integration test runners                         |
| Delivery automation    | GitHub Actions                   | Runs lint/types/tests, then deploys merged main to staging                         | CI/CD                                                     |

Our database-backed services frequently use parameterized D1 SQL directly, especially
for guarded transactional batches. It is inaccurate to draw every write as going
through Drizzle. Types prevent many coding mistakes; runtime validation, authorization
and database constraints protect the real boundary.

## One complete request and order lifecycle

```text
Customer browser (future storefront)
  | POST /api/orders: customer + SKU/quantity + Idempotency-Key
  | No admin JWT, no browser HMAC secret, no trusted price or actor
  v
Worker → Hono → request limits + Zod → public order service
  | Load active product price/COGS from D1; normalize Moroccan phone
  | Compute COD in integer centimes; snapshot item price + cost
  | transition(NEW → CONFIRMING, actor=system)
  v
One D1 batch
  inbox/idempotency record + customer upsert + order + items
  + order event + outbox task
  | Return a minimal order receipt, never other customer records
  |
Admin browser → Cloudflare Access → Google/email policy
  | Worker verifies JWT signature/JWKS, issuer, AUD and expiry
  v
Hono /admin/orders → private French queue
  | Confirmé → transition(CONFIRMING → CONFIRMED, actor=user)
  | One batch: confirmation attempt + order state + audit event
  | Pas de réponse ×3 → CANCELLED/no_answer
  v
Créer le colis → ManualCourierClient → PACKED
  | Save SELF- tracking reference; no vendor request or invented label
  | Human records explicit delivery/return fees + justification
  | Fees and audit commit together; no state change
  v
Remis / Expédié → shared status service → SHIPPED
  | One batch: shipment state/event + order state/event
  | + negative inventory movement + deferred-work row
  v
Livré → DELIVERED
  | Delivery is NOT proof of payout; courier events cannot SETTLE
  v
Admin settlement CSV → parser → authoritative shipment/order lookup
  | Expected net = frozen COD − applicable known fees
  | Preview is read-only; wrong/missing fees remain exceptions
  | Admin verifies actual receipt outside the app and explicitly approves
  v
One snapshot-guarded D1 batch
  statement + lines + immutable report + DELIVERED → SETTLED event/state
  v
Dashboard → SELECT/read models → French amounts and Casablanca week
  No rewriting source stock, history or financial truth
```

The separate `POST /api/webhooks/orders` boundary is for trusted server senders:
it verifies the raw-body HMAC before parsing, then uses the same ingestion service.
Public browser checkout must not contain that signing secret. A curl request is not
automatically illegitimate: server validation and authoritative data protect the API,
not the fact that a request came from our UI.

### Price snapshots and stock are different

The browser can display an 89 MAD price, but cannot authorize a 1 MAD purchase by
editing JSON. The backend reloads the product and freezes price/COGS in `order_items`.
Later catalogue edits do not rewrite an existing order's agreed amounts or margin.

Stock is the sum of inventory movement deltas. Shipping subtracts; an actual return
adds back. Checkout currently checks active SKU existence, **not available-stock
reservation**. A customer can place an order that needs stock review; overselling
prevention is not implemented and must not be promised by the frontend.

## Why retries are safe

Idempotent means repeating the same operation does not repeat its effects.

- Public checkout keeps a stable idempotency key and canonical request. Same key and
  same payload returns the original receipt; changed payload with that key is a conflict.
- Signed order ingestion uniquely identifies source/event under the store. Its inbox
  insert and all order effects share a transaction; a duplicate cannot increment the
  customer count or create another order/items/outbox task.
- Courier events have stable external IDs. Duplicate replay does not add another
  shipment event, order event or stock movement. Manual actions use shipment/action IDs.
- Inventory operations use reference-based uniqueness; stock is never overwritten.
- Identical manual fees are a no-op. Known fees cannot be changed using that endpoint.
- Settlement reference/content and shipment matching prevent a second payout match.

A pre-query is only an optimization: unique constraints handle racing requests.
Atomicity means a grouped database write commits completely or rolls back completely.
State and event must share a transaction: otherwise an order might say SHIPPED without
its explanation/stock movement, or history might claim a transition that never committed.
The fee audit similarly cannot be lost while leaving changed financial expectations.

## Outbox: queued is not sent

An outbox row is durable intent to do work after the request transaction. The scheduled
Worker can claim bounded batches, fence claims by tokens, enforce timeouts, retry with
backoff and stop exhausted jobs. The dashboard exposes pending/failed work safely.

Production dispatch is intentionally unconfigured. Cron therefore leaves tasks
unconsumed rather than pretending a WhatsApp/message was delivered. A real handler must
define the destination, credentials, idempotency behavior and operational monitoring.
An outbox processor alone cannot guarantee exactly-once external delivery: a crash
after sending but before acknowledgement needs the receiving system's deduplication.

## Settlement and dashboard: what the money means

DELIVERED says the parcel reached the customer. SETTLED says an approved reconciliation
matched a delivered shipment and its expected money. The application does not query a
bank: an admin verifies receipt externally. A synthetic staging receipt is a simulation,
not evidence of a real cash transfer.

Expected COD, CSV-reported payout and entered receipt are separate values. Matching
only the net is insufficient: an incorrect COD offset by an incorrect fee is still an
exception. Unknown fee is `NULL`, never silently zero. Exact rows can settle; unmatched,
duplicate, status-conflict and variance rows stay visible for review.

The dashboard is a read model, not a second ledger. It derives metrics from source
tables and uses the configured Casablanca week. Staging includes fictional seeds and
archived synthetic orders; its figures are not real shop sales. Machine-test archive
restores inventory by appending compensation, but does not exclude test rows from KPIs.

## Live evidence and tests

The [machine rehearsal contract](testing/staging-order-lifecycle.md) records three
successful five-case runs, an authentication-denied run, zero orders on denied
preflight, restoration of the exact-token policy and the expected persisted counters.
It tests signed ingestion/status webhooks, **not settlement**.

Separate public-checkout rehearsal, started 2026-10-03:

- Order `PARA-74C3B458E52E0762`, ID `01a103ea-ebe6-70f8-9268-7eb09a6efa67`.
- Fictional customer/address, note `WEEK3_REVIEW_SYNTHETIC`; no external delivery.
- `VITC-1000-001` ×1, authoritative price 8,900 centimes and COGS 5,200 centimes.
- Checkout reached CONFIRMING; Google-authenticated admin confirmed and created a
  manual parcel, reaching PACKED.
- Initial manual handoff form was rejected. Investigation identified Hono's
  `no-referrer` default interacting with the strict form Origin requirement.
- The parcel had unknown fees, correctly blocking exact settlement. User approved
  explicit human fee recording instead of silently setting a database fee to zero.
- [PR #35](https://github.com/101Amine/AnfashPara/pull/35) passed CI, was merged with
  explicit approval and deployed as `52c63c62e01a779e8d7a54f85480e1f5bc961f8f`.
- [Deployment](https://github.com/101Amine/AnfashPara/actions/runs/37160188716)
  succeeded and `/api/version` matched the merge SHA. Real browser submissions now
  saved explicit zero fees and successfully recorded handoff and delivery.
- The human imported `WEEK3-SYNTHETIC-ed4bdcd8518f435cbf151fbe43ee1d62`, courier
  `self-delivery`, period 2026-10-03, **simulated receipt** 89 MAD. Preview showed one
  exact line, zero exceptions, net expected/reported/receipt 8,900 centimes, variance 0.
- [Saved staging report](https://para-api-staging.alanfashpara.workers.dev/admin/settlements/reports/01a103fe-d556-7dba-82b0-34822c6e8fce)
  requires Google admin authentication. D1 independently confirmed `SETTLED`, a
  `matched` settlement line, 8,900-centime net and zero expected fee.
- Stock was 18 before checkout, 17 after shipping, and remained 17 through settlement.
  A human submitted one uniquely referenced **synthetic compensation** of +1 through
  the inventory admin workflow, restoring 18 without deleting shipment/history rows.
- The dashboard's known expected payout moved from **89 MAD to 0 MAD** after matching.
  Other synthetic runs added unknown-fee deliveries concurrently; their counts are
  not a clean before/after measure of this one order. Stock read model agrees with D1.
- [Post-fix five-case machine run](https://github.com/101Amine/AnfashPara/actions/runs/37160308284)
  passed and archived at the same deployed merge SHA.

Persisted order event sequence (seven entries):

| From → to              | Actor          | Reason                                       |
| ---------------------- | -------------- | -------------------------------------------- |
| NEW → CONFIRMING       | system         | order_ingested                               |
| CONFIRMING → CONFIRMED | human admin    | customer_confirmed                           |
| CONFIRMED → PACKED     | human admin    | parcel_created                               |
| PACKED → PACKED        | human admin    | manual_fees_recorded (audit, not transition) |
| PACKED → SHIPPED       | human admin    | manual_picked                                |
| SHIPPED → DELIVERED    | human admin    | manual_delivered                             |
| DELIVERED → SETTLED    | reconciliation | settlement_matched                           |

The shipment is `01a103ef-4083-7b4c-83ba-4813cf02a284`, tracking
`SELF-PARA-74C3B458E52E0762-9A6EFA67`. Inventory retained exactly one -1 movement
with reference `order:01a103ea-ebe6-70f8-9268-7eb09a6efa67:shipped` and one +1
with reference `admin:week3-review-ed4bdcd8518f435cbf151fbe43ee1d62-compensation`.
No database stock total was overwritten. Synthetic order/statement history remains
as evidence. Its deferred-work rows remain queued because dispatch is unconfigured;
review/exclude synthetic jobs before activating any real notification handler.

Operational quirk: the settlement form still defaults to courier `manual`, whereas
the configured manual client stores courier name `self-delivery`. Reconciliation
requires the exact saved courier identifier; we explicitly entered `self-delivery`.
Do not confuse the client's **mode** with its stored courier **name**.

Local validation for PR #35: lint, strict typecheck and **562 tests** passed.
Fee tests include actual migrations/CHECKs, failed audit rollback, decimal conversion,
concurrent submissions, known-fee locks, service/Origin rejection and private rendering.

## Admin security/cache review

Every `/admin/*` request runs Access JWT middleware before route code; HTML and JSON
are not publicly cacheable. Routes also set private/no-store and identity/Accept Vary
where applicable. Public catalogue/settings alone use public 60-second caching.

| Surface                           | Authorization and write boundary                              | Review finding                                                         |
| --------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Queue / confirmation              | Human JWT; synthetic service confirmation only                | Phone search/cursors; explicit foreign-origin POST rejected            |
| Parcels / manual outcomes         | Human JWT; synthetic service actions only                     | Manual form requires same origin; legal transitions; atomic inventory  |
| Labels / batch ZIP                | Human JWT, bounded selection, trusted label origins           | No genuine labels configured; missing label is an explicit error       |
| Settlement preview/import/reports | Human JWT; bounded CSV; same-origin checks; explicit approval | Read-only preview, stale-approval guard and atomic financial writes    |
| Outbox monitoring                 | Human JWT; escaped, redacted read-only view                   | No production notification handler                                     |
| Dashboard                         | Human JWT; read-only store-scoped queries                     | Staging test data is included in figures                               |
| Inventory operations              | Human JWT; exact Origin; bounded input/reference guards       | Append-only movement plus audit; no direct stock overwrite             |
| Manual fees                       | Human JWT only, exact Origin, 4 KiB body limit                | Explicit amounts, immutable known fees, transactional audit            |
| Staging lifecycle endpoint        | Exact staging host/environment + allowlisted service JWT      | All synthetic markers required; general admin/service writes forbidden |

Header behavior is covered by tests; Google access and machine restrictions are verified
separately. The live browser rehearsal remains essential because unit tests construct
Origin headers explicitly and did not reveal the browser navigation policy interaction.

## Justified carryover — not a frontend deadline

1. Read this review and explain the layers; keep technical acceptance separate from
   business readiness. No unverified core rehearsal step is carried forward.
2. Agree how much stock checkout may promise: reservation/availability, concurrent
   orders and cancellation/expiry release. This is backend work, not CSS.
3. Expose a safe SKU/catalogue contract: `/api/products` currently returns ID/name/slug/
   price, while checkout expects SKU. Frontend integration needs a deliberate mapping.
4. Define delivery-zone pricing: public checkout currently uses zero customer shipping
   fee. Do not introduce arbitrary prices in browser code.
5. Design the actual deferred notification handler and retry/monitoring operations.
6. Only when a courier is selected: sanitize its contract, implement a real adapter and
   configure trusted genuine label sources. Manual/self-delivery remains valid meanwhile.
7. Production readiness later: separate bindings/secrets, abuse protection beyond the
   isolate-local rate limiter, backups/recovery rehearsal, privacy/data retention,
   monitoring and deployment approval. No production launch is authorized by this review.
8. Decide whether synthetic staging records should be excluded from analytics, and how
   fee corrections/statement exceptions are reviewed without rewriting settled history.

Keep the next batch small: learning/acceptance first, then catalogue/stock decisions.
Frontend framework, brand, navigation and visual direction are a separate design phase
chosen with the user; no rushed storefront or new frontend tickets are created here.

## Explain-back: answers you should be able to give

1. **Worker vs Hono?** Worker executes the app; Hono routes HTTP inside that app.
2. **D1 vs Drizzle?** D1 stores SQL data; Drizzle describes schema/builds queries.
3. **Why validate in backend too?** Anyone can alter browser input or call HTTP directly.
4. **Why re-verify Access JWT?** The API validates signed identity, intended application,
   issuer and expiry itself; it does not trust a plain email/header or gateway assumption.
5. **Google vs service token?** One represents an interactive allowed person; the other
   authenticates a narrowly scoped staging machine. The Worker verifies both assertions.
6. **JWT vs webhook HMAC?** JWT carries signed identity/claims; webhook HMAC authenticates
   exact request bytes using a shared server-side secret. Neither belongs in public JS.
7. **Why freeze price/COGS?** An existing order must not change when the catalogue changes.
8. **Why state + event + stock together?** They describe one operation and must not disagree.
9. **Why isn't delivered settled?** Delivery and receiving reconciled cash are different facts.
10. **Why not stock = an editable number?** A movement ledger preserves reasons and makes
    retries/corrections auditable; the current balance is calculated from that history.
11. **Does an outbox row mean a message was sent?** No; it means delivery intent is durable.
12. **Is the backend 100% finished?** The staging foundation works; remaining commercial,
    security and integration decisions are explicitly listed rather than hidden by a percentage.

## Read the code by responsibility, not file order

- [Public API contract](contracts/internal-api.md) and `apps/api/src/modules/public-orders`.
- `packages/core/src/orderStateMachine.ts`: pure actor/transition rules.
- `apps/api/src/modules/order-ingestion`: snapshots and transactional ingestion.
- [Outbox contract](contracts/outbox.md) and `apps/api/src/modules/outbox`.
- [Manual fee contract](contracts/manual-shipment-fees.md).
- [Reconciliation contract](contracts/settlement-reconciliation.md).
- [Dashboard contract](contracts/dashboard.md) and `apps/api/src/modules/dashboard`.
- [Living architecture SVG](architecture/anfash-architecture.svg).
