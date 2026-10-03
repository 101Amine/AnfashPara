<!-- docs/week-02.md -->

# Week 2 review — from an HTTP request to an auditable order

Week 2 turned the Week 1 foundations into a small fulfillment system. An order can enter the API,
be confirmed by an authenticated administrator, receive a parcel, react to delivery events, adjust
stock, and expose labels without trusting the browser or the courier more than necessary.

This document is both the week review and a learning guide. It explains what each technology does,
where its responsibility stops, and why the data is written in the order it is.

## 1. The stack, one responsibility at a time

```text
Internet client
    |
    | HTTPS request
    v
Cloudflare network
    |-- /admin/*: Cloudflare Access checks the Google identity first
    |-- /api/*: request continues to the Worker
    v
Cloudflare Worker              runtime: starts our code for the request
    v
Hono                           HTTP layer: route, method, middleware, response
    v
Zod + authentication checks    boundary: reject invalid or untrusted input
    v
Service function               use case: apply the business workflow
    v
Order state machine            domain rule: decide whether a status move is legal
    v
D1 batch / prepared SQL        persistence: commit related writes atomically
    v
Cloudflare D1                  durable SQLite-compatible database
```

These names are not interchangeable:

| Technology        | Its job here                                                       | Familiar comparison                           |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Cloudflare Worker | Runs the TypeScript API close to Cloudflare's network              | The process containing a Spring Boot app      |
| Hono              | Matches URLs and HTTP methods, runs middleware, builds responses   | Spring MVC controllers and filters            |
| Cloudflare Access | Stops unauthorized `/admin/*` traffic before it reaches the Worker | An identity-aware reverse proxy               |
| JWT + JWKS        | Lets the Worker independently verify who Access authenticated      | A signed security token and public key set    |
| Zod               | Validates unknown request data at runtime                          | Bean Validation, but schema-first             |
| D1                | Stores relational data durably                                     | Managed SQLite; the database itself           |
| Drizzle           | Defines typed database schema and builds some SQL                  | JPA/query builder, but much thinner           |
| Prepared D1 SQL   | Executes parameterized SQL directly                                | `JdbcTemplate`/prepared statements            |
| `@para/core`      | Holds pure business rules with no HTTP or database dependency      | A domain module                               |
| Wrangler          | Develops, migrates, configures, and deploys the Worker and D1      | CLI for build, deployment, logs, and database |
| Vitest            | Runs automated tests                                               | JUnit                                         |

Drizzle is not used for every query. It defines the schema and handles simple typed reads such as
products and settings. The multi-write workflows use explicit prepared SQL and `D1.batch()` because
the transaction boundaries are easier to see and review. Both approaches still talk to the same D1
database.

## 2. Three kinds of trust

Before following an order, separate the three request types:

### Public reads

`GET /api/products`, `/api/settings`, `/api/health`, and `/api/version` do not contain private
customer data. Products and settings may be cached for 60 seconds.

### Signed machine requests

`POST /api/webhooks/orders` and `POST /api/webhooks/courier` use HMAC-SHA-256 signatures. The sender
and Worker share a secret. The sender signs the exact raw bytes, and the Worker verifies those bytes
before parsing JSON.

HMAC answers: “Did a holder of this shared secret send exactly this body?” It does not create a user
session and it must never be embedded in browser JavaScript.

### Authenticated administrator requests

Every `/admin/*` request passes two checks:

```text
Google login
  -> Cloudflare Access policy allows the email
  -> Access signs a JWT assertion
  -> Worker verifies signature, issuer, audience, expiry, and email
  -> Hono route may run
```

This is defense in depth. Access is the first gate. Worker verification prevents our application
from trusting a forged identity header if traffic reaches it through an unexpected path.

## 3. Complete order request lifecycle

The easiest way to understand the system is to follow one fictional order.

### Step 1 — the request reaches Cloudflare

The current ingestion entry point is:

```http
POST /api/webhooks/orders
X-Para-Signature: sha256=<HMAC of the exact body>
Content-Type: application/json
```

Cloudflare starts the Worker and passes it the request plus bindings such as `DB` and Worker
secrets. A binding is an object or secret Cloudflare makes available to Worker code; it is not sent
by the browser.

### Step 2 — Hono chooses the route

Hono matches the method and path to `orderWebhook.routes.ts`. The route is the HTTP adapter. It
should not decide prices or create SQL itself. It performs edge concerns:

1. ensure the secret and D1 binding exist;
2. read the body as text;
3. verify its HMAC signature;
4. parse JSON only after signature verification;
5. validate the parsed value with Zod;
6. call the ingestion service;
7. translate the result or domain error into an HTTP response.

“Validate before parsing” in the ticket meant “verify the signature before parsing.” We still have
to read the raw bytes, because parsing and re-serializing JSON could change spaces or key order and
therefore change the signed bytes.

### Step 3 — the service establishes trusted values

The service normalizes the Moroccan phone number and loads every requested SKU from D1. It does not
accept product price, COGS, store ID, total, or status from the request.

```text
request item: { sku: "VITC-1000-001", quantity: 1 }
                                 |
                                 v
D1 product: price = 8,900 centimes, COGS = trusted stored value
                                 |
                                 v
order_items freezes those values for this specific order
```

The product price may change tomorrow, but yesterday's order must still explain what the customer
owed and what the item cost at the time of purchase. That is why `order_items` stores a snapshot.

### Step 4 — ingestion commits one atomic D1 batch

One successful ingestion writes all of the following:

1. `webhook_inbox`: the external event ID and raw payload;
2. `customers`: insert the customer or update the existing normalized-phone record;
3. `orders`: the new order in `CONFIRMING`;
4. `order_items`: quantity plus frozen price and COGS;
5. `order_events`: the audited `NEW -> CONFIRMING` transition;
6. `outbox`: a future `order.confirmation.requested` job.

These statements are submitted through one `D1.batch()`. D1 commits all of them or none of them.
The response is HTTP `201` only after that batch succeeds.

### Step 5 — the admin queue reads the order

An authenticated administrator opens `GET /admin/orders`. The repository applies status/search
filters and stable cursor pagination. Hono renders a mobile-first French HTML page.

The response is `private, no-store`. A shared browser or CDN must not cache customer names, phone
numbers, addresses, or operational actions.

### Step 6 — confirmation uses the state machine

The operator can select `Confirmé`, `Pas de réponse`, `Annulé`, or `Rappeler`. The route does not
write an arbitrary status. It calls the pure `transition()` function in `@para/core`.

```text
CONFIRMING --confirmed------> CONFIRMED
CONFIRMING --no answer------> NO_ANSWER
NO_ANSWER  --no answer #2---> NO_ANSWER
NO_ANSWER  --no answer #3---> CANCELLED (reason: no_answer)
CONFIRMING --cancelled------> CANCELLED
```

The state machine also checks the actor. A verified `user:<email>` can confirm an order. A courier
cannot. A courier can later report delivery, but cannot mark money as settled.

The confirmation service atomically inserts `confirmation_attempts`, inserts `order_events`, and
updates `orders.status`. If any of those writes fails, none is kept.

### Step 7 — parcel creation crosses an external boundary

Only `CONFIRMED` orders may create a parcel. The service loads trusted order/customer/item data,
then calls the `CourierClient` interface:

```ts
interface CourierClient {
  createParcel(input: CreateParcelInput): Promise<CreateParcelResult>;
  getStatus(trackingNumber: string): Promise<CourierStatus>;
}
```

Core code depends on this interface, not on a vendor SDK. Today, `ManualCourierClient` generates a
deterministic self-delivery tracking number without API credentials. A future vendor adapter can
implement the same interface.

The courier call happens before the local D1 writes. A remote courier and D1 cannot share one local
database transaction. We therefore send the stable order ID as the courier idempotency key. If the
courier accepted the parcel but our D1 write failed, a retry should return the same parcel rather
than create a second one.

After courier success, one D1 batch stores the shipment, updates the order, inserts transition
events, and—if the parcel is already considered shipped—records the stock movement.

### Step 8 — courier status synchronization

Courier updates can enter through a signed webhook. API-managed couriers may also be polled by the
scheduled Worker as a fallback. Both paths call the same synchronization service, so the business
rules do not depend on how the event arrived.

Raw values such as `Livré`, `Refusé`, and `Retourné` are mapped to normalized internal values. The
state machine then produces legal order transitions:

```text
PACKED  --delivery event--> SHIPPED --> DELIVERED
PACKED  --refusal event---> SHIPPED --> REFUSED --> RETURNED
```

The service records the raw courier status as evidence, but the rest of the application uses the
normalized status. Unknown values are rejected rather than guessed. Out-of-order older events are
recorded as stale evidence without moving the current status backward.

### Step 9 — inventory is a ledger, not a number to overwrite

There is no mutable `products.stock = 17` field. Stock is derived by summing movements:

```sql
SELECT COALESCE(SUM(quantity), 0)
FROM inventory_movements
WHERE store_id = ? AND sku = ?;
```

- purchase: positive movement;
- first transition to `SHIPPED`: negative item quantities;
- `RETURNED`: positive quantities;
- delivered or refused: no extra movement, because stock already left when shipped.

A stable reference such as `order:<id>:shipped` is unique per store, SKU, reason, and reference.
That unique constraint is a second protection against duplicate stock movements.

### Step 10 — labels never bypass admin authentication

This module is implemented in
[PR #14](https://github.com/101Amine/AnfashPara/pull/14), but that PR is not yet merged into `main` at
the time of this review.

The admin can view/download one stored label or print/download a selected batch. Label files are
fetched through our authenticated Worker route. The raw courier URL is not placed in public HTML.

The proxy accepts only explicitly allowed HTTPS origins, PDF/PNG/JPEG content types, bounded file
sizes, and non-redirecting responses. Missing labels return a useful controlled error instead of a
broken link.

## 4. Why ingestion is idempotent

Idempotent means that retrying the same logical operation has the same business effect as doing it
once.

Retries are normal, not exceptional. A sender can time out after our database committed but before
it received our HTTP response. It cannot know whether the order exists, so it sends the event again.

Without idempotency:

```text
first request commits order A
response is lost
retry commits order B
one customer receives two parcels
```

With idempotency:

```text
first eventId "evt-123" -> inbox row + order -> 201
same eventId "evt-123"  -> inbox row already exists -> 200 { duplicate: true }
```

There are two protections:

1. the service checks `webhook_inbox` before doing work, which makes the common retry cheap;
2. a database unique index on `(store_id, source, external_event_id)` settles races where two copies
   arrive together.

The second protection matters because “check, then insert” is not atomic by itself. Two requests can
both check before either inserts. Only the database uniqueness rule can decide the winner reliably.

Courier events use the same idea. Inventory movements add another stable unique reference so a bug
or alternate code path still cannot subtract or restore the same order stock twice.

Idempotency is not authentication. HMAC proves who could have sent the request; the event ID proves
whether this logical event was already applied. We need both.

## 5. Why the transition and event share a transaction

`orders.status` answers “where is the order now?” `order_events` answers “how did it get there?”
They describe the same fact from two views and must never disagree.

If the status committed without its event:

- the admin would see `DELIVERED`;
- there would be no evidence of who or what delivered it;
- debugging, reconciliation, and customer disputes would lose the audit trail.

If the event committed without the status:

- history would claim delivery;
- the queue would still show `SHIPPED`;
- a retry might attempt the transition again and duplicate side effects.

The service therefore builds the legal transition in memory, then submits the status update, event
insert, and related side effects—such as inventory movement—in one D1 batch:

```text
transition() says the move is legal
          |
          v
[update order, insert event, insert inventory movement]
          |
          +-- every statement succeeds --> COMMIT
          |
          +-- any statement fails -------> ROLLBACK everything
```

The pure state machine cannot partially write because it performs no I/O. The service owns the
transaction because it knows which persistent facts must change together.

## 6. Courier quirks and Week 2 operational decisions

| Quirk or risk                                    | Decision made in Week 2                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| No courier selected and we may self-deliver      | Default to `COURIER_MODE=manual`; require no fake vendor credentials                     |
| Vendor APIs differ                               | Hide integrations behind `CourierClient`                                                 |
| A courier call and D1 cannot share a transaction | Call courier first; use the order ID as a stable courier idempotency key                 |
| Webhooks are commonly delivered more than once   | Deduplicate by courier source and external event ID                                      |
| Events can arrive late or out of order           | Store stale evidence but do not move the current shipment backward                       |
| Couriers use inconsistent status words           | Map raw English/French values to a small normalized status set                           |
| A courier knows delivery, not bank settlement    | Courier actors may never produce `SETTLED`; only reconciliation may do so                |
| Manual delivery has nothing meaningful to poll   | Scheduled polling skips `COURIER_MODE=manual`                                            |
| A failed courier request should be retryable     | Do not write a shipment or advance the order when `createParcel()` fails                 |
| Labels may be absent in manual/self-delivery     | Show `Étiquette indisponible`; do not invent a URL                                       |
| Remote label URLs are untrusted                  | Proxy via authenticated routes and allowlist origins/types/sizes                         |
| Returned does not always mean sellable stock     | Current code restores returned quantity; physical inspection/write-off remains carryover |
| Delivery/return fees vary by courier             | Store fees on shipments; settlement variance handling is Week 3                          |

Operationally, we also chose to keep the first system first-party. The storefront, checkout, API,
and admin will belong to this repository rather than depending on YouCan or a courier-specific data
model.

One consequence is still visible: `/api/webhooks/orders` is currently a signed server-to-server
ingestion and staging-test route. It is not suitable for a browser because a browser cannot keep the
HMAC secret private. The first-party browser checkout needs its own `POST /api/orders` boundary with
an idempotency key, strict validation, abuse protection, and server-side price lookup.

## 7. What Week 2 delivered

- Full operational D1 schema, migrations, constraints, indexes, and realistic seed data.
- Pure 11-status order state machine with actor guards and three-no-answer cancellation.
- Signed, deduplicated order ingestion with frozen product economics.
- Cloudflare Access-protected mobile admin queue with filters, search, cursor pagination, and SLA.
- Atomic confirmation attempts and order-event history.
- WhatsApp confirmation links using normalized Moroccan phone numbers.
- Courier abstraction with deterministic fake and manual clients.
- Retry-safe parcel creation.
- Courier webhook normalization, deduplication, stale-event handling, and polling fallback.
- Append-only inventory movements tied atomically to order transitions.
- Authenticated single and batch label workflows implemented in PR #14, pending merge into `main`.
- Live five-order staging exercise covering delivered, refused/returned, cancellation, three missed
  calls, and duplicate replay.

The verified staging run finished with:

```text
DELIVERED | RETURNED | CANCELLED | CANCELLED | DELIVERED
```

The duplicate replay produced one inbox row, one shipment event, and one inventory movement.

## 8. Week 3 carryover

Ordered by dependency and business value:

1. **Merge the completed labels work** — review and merge
   [PR #14](https://github.com/101Amine/AnfashPara/pull/14) so `main` contains the already implemented
   authenticated label module.
2. **First-party browser order endpoint** — add `POST /api/orders` using `Idempotency-Key`, rate/abuse
   controls, trusted D1 pricing, and the same ingestion service invariants.
3. **Manual shipment status controls** — protected admin actions for picked, delivered, refused, and
   returned self-deliveries; do not require a fake courier webhook for owner delivery.
4. **Settlement import and reconciliation** — ingest courier CSV/XLSX statements, match tracking
   numbers, calculate expected net amounts, surface missing/wrong fees, and allow only this workflow
   to move `DELIVERED -> SETTLED`.
5. **Outbox processor** — scheduled delivery with retries, backoff, attempt counts, and observable
   failures for confirmation/shipping notifications.
6. **Operations dashboard** — weekly placed/confirmed/delivered/refused counts, expected payout,
   refusal rate per SKU, campaign contribution, and derived stock.
7. **Inventory operations** — purchase-entry UI, physical return inspection, damaged/write-off
   movements, and a weekly count/reconciliation procedure.
8. **Persistent staging automation credentials** — create a staging-only Cloudflare Access service
   token and managed webhook secrets so the lifecycle smoke test can run unattended in CI.
9. **Real courier adapter, only after selection** — record actual authentication, status mappings,
   fees, label behavior, retry semantics, and webhook signature contract from official docs.
10. **Real label configuration** — configure `COURIER_LABEL_ORIGINS` only when a selected courier
    provides genuine label URLs.
11. **Business readiness, deliberately deferred** — supplier invoice/ICE, stock receipt and physical
    checks, courier agreement, content, packaging, and real test parcels. These are not software
    failures; they wait until the business is ready to spend and operate.

## 9. Explain-back checkpoint

Try answering these without looking above. If one feels vague, that topic should be reviewed before
adding the next module.

1. What is the difference between a Worker, Hono, Drizzle, and D1?
2. Why does `/admin/orders` use Access/JWT while a courier webhook uses HMAC?
3. Why is a client-supplied price ignored even if the frontend displays the correct price?
4. What problem does an event ID solve that an HMAC signature does not?
5. Why are both a pre-check and a unique database index used for duplicate events?
6. Which facts must commit together when an order becomes `SHIPPED`?
7. Why can a courier report `DELIVERED` but not `SETTLED`?
8. Why is stock calculated from movements instead of overwritten?
9. Why does parcel creation need an idempotency key even though D1 writes are transactional?
10. Why can the future browser checkout not reuse the signed webhook secret?

The shortest correct summary is:

> Hono receives and validates a request inside a Cloudflare Worker. Pure core code decides whether
> the business transition is legal. A service commits the new state, its audit event, and related
> side effects atomically in D1. Authentication proves who may ask; idempotency prevents retries from
> applying the same business action twice.

## 10. Source map for the next review

- Architecture diagram: [`architecture/anfash-architecture.svg`](architecture/anfash-architecture.svg)
- Order state machine: [`../packages/core/src/orderStateMachine.ts`](../packages/core/src/orderStateMachine.ts)
- Order ingestion contract: [`contracts/order-ingestion-webhook.md`](contracts/order-ingestion-webhook.md)
- Parcel decisions: [`contracts/create-parcel.md`](contracts/create-parcel.md)
- Courier synchronization: [`contracts/courier-status-sync.md`](contracts/courier-status-sync.md)
- Inventory ledger: [`contracts/inventory.md`](contracts/inventory.md)
- Labels pending merge: [PR #14](https://github.com/101Amine/AnfashPara/pull/14)
- Staging proof: [`testing/staging-order-lifecycle.md`](testing/staging-order-lifecycle.md)
