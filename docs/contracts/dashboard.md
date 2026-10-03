<!-- docs/contracts/dashboard.md -->

# Operations dashboard — #22

`GET /admin/dashboard` serves French HTML by default and aggregate JSON with
`Accept: application/json`. Cloudflare Access intercepts the request; the existing
Worker middleware verifies the Access JWT again before the route runs. HTML, JSON
and database errors are `private, no-store, max-age=0`, with `Vary: Accept, Cookie,
Cf-Access-Jwt-Assertion`. No mutation or public analytics endpoint is added.

## Request lifecycle

```text
Admin → Access → Worker JWT verification → Hono dashboard route
  → presenter resolves Casablanca Monday and following Monday
  → repository executes five bound SELECTs in one D1 batch
  → aggregate read model → JSON or escaped French HTML
```

The repository owns SQL and store isolation (`para-main`). The presenter owns local
calendar boundaries, percentages and MAD formatting. The view owns layout and
escaped output. Hono owns authentication wiring, response negotiation and controlled
503 errors. These operational tables remain the only source of truth: refreshing the
dashboard never writes a new stock total or changes an order.

## Exact definitions

| Value                 | Definition                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placed                | Orders whose `placed_at` falls in the current local week.                                                                                                                                                                                                                  |
| Confirmed             | Orders whose `confirmed_at` falls in that week, even if subsequently cancelled.                                                                                                                                                                                            |
| Delivered / refused   | Distinct order IDs with the corresponding `order_events` transition in that week. Replayed events cannot multiply counts; later SETTLED or RETURNED does not erase the original outcome.                                                                                   |
| Expected payout       | All-period delivered orders with delivered shipments, excluding SETTLED orders and shipments already having a matched settlement line. Sum frozen COD minus known delivery fee. Unknown fees are excluded and counted visibly.                                             |
| SKU refusal rate      | Distinct refused orders / distinct orders with delivered or refused events this week, per SKU. Duplicate item rows and item quantity do not multiply orders. If both outcomes exist, refusal takes precedence in this rate; the activity cards still show both activities. |
| Campaign contribution | Orders placed this week grouped by campaign and `utm_content`; order count and frozen COD sum. Missing/blank values form a visibly unattributed group. This is ordered value, not collected revenue or campaign profit.                                                    |
| Stock                 | All-period sum of signed inventory movements per catalogue SKU, including inactive products. No movements means zero; negative balances remain visible.                                                                                                                    |

Weekly cards measure activity, not a conversion funnel of the same cohort. A delivery
this week may belong to an order placed last week. Shipment webhook occurrence time
is not substituted for the committed order-event timestamp.

Expected payout is explicitly **delivery-only**, not a comprehensive courier account
balance: return fees, refused parcels, bank receipts and fee disputes are not silently
netted into it. Missing shipments or inconsistent shipment states are not eligible.
Reconciliation exceptions still require the settlement report. A zero sum with unknown
fees is not proof that nothing is due.

## Calendar and money

The week starts Monday 00:00 in `Africa/Casablanca`. Each boundary is converted to
UTC independently using runtime IANA timezone data: Ramadan offset changes can make
a week 167 or 169 hours. SQL uses half-open intervals `[start, min(nextMonday, asOf))`
to avoid double counting boundaries or future activity. The JSON includes `timezone`,
`start`, `end` and `asOf`; end is next Monday, while asOf is the effective cutoff.

Stored values and SQL sums stay in integer centimes. Unsafe integer aggregate amounts
fail closed with a controlled 503. Only the presenter converts centimes for French
MAD display. Percentages are derived display values, not stored financial values.

## Bounded reads and index evidence

Five read statements run in a single D1 batch. Returned lists are bounded: top 20 SKU
refusal rates, top 20 campaign/content groups by order count, and first 50 SKU balances.
Tie-breakers are deterministic; these are labelled slices, not an exhaustive export.
Scalar card totals are not truncated. Query cost still grows with historical tables:
bounded output is not a claim of bounded rows scanned.

`EXPLAIN QUERY PLAN` on the migrated test database shows the payout query selecting
`shipments_store_status_index`, order primary-key lookup and
`settlement_lines_shipment_index`; stock uses
`inventory_store_sku_created_index`. Existing indexes suffice for the current scope;
no speculative index or migration is added. Event-week aggregates can scan history;
reassess with realistic volume and query plans before introducing indexes/read models.

## Privacy, tests and operational caveats

Queries never select customer names, phone numbers, addresses, JWTs or raw payloads.
The aggregate response intentionally contains catalogue and campaign values only.
Those strings are escaped in HTML; do not put customer details in UTM values.

Tests use fictional data and actual migrations through 0006. They cover activity and
cohort distinctions, replay-safe outcomes, ledger balance, unknown fees, matched and
SETTLED exclusions, store isolation, week/year/Ramadan boundaries, empty states,
escaping, Access enforcement, no-store, sanitized failures and query plans.

No staging data or secrets are changed by this ticket. After merge/deployment, sign in
and visit `/admin/dashboard`; compare cards with event history and check the payout
definition before interpreting the amount. Automated staging rehearsal remains #24.
