# Outbox processor — Week 3, issue #21

## What this adds, and what is deliberately paused

The processor, handler contract, deterministic fake, cron composition and protected monitoring page
are implemented. No production email, WhatsApp or other delivery adapter has been selected.
Consequently the deployed scheduled composition returns `handler_unconfigured` and **does not
claim or consume any outbox row**. The fake is exported only from `@para/core/testing` and is never
installed in production. A future adapter can perform internal work or external delivery; it must
meet the cancellation/idempotency contract before being supplied to `runScheduledTasks`.

This pause preserves pending work. A no-op handler that marks notifications done would falsely
claim delivery and prevent the real handler from processing those jobs later.

## Why not send a notification while saving an order?

D1 can atomically save an order and its outbox row. It cannot atomically commit that SQL transaction
and send an email through another system. Sending first risks notifying a customer about an order
that then fails to save. Saving first without an outbox risks losing the notification after a crash.

```text
Order request
  → one D1 transaction: order + items + event + pending outbox row
  → response to storefront

Scheduled Worker
  → shipment polling and outbox run independently
  → bounded selection of due jobs
  → conditional SQL claim: processing + fresh token + lease + attempt increment
  → validate topic, aggregate and payload
  → handler(message, cancellation) with a stable idempotency key
  → token-fenced acknowledgement:
      success → done
      retryable failure → failed + next attempt time
      poison/permanent/exhausted → failed, no next attempt
```

The outbox row is a durable promise to do work later. Committing that promise with the order is
the reliable part; the processor can retry it without repeating the original order transaction.
The processor never changes orders or inventory.

## Core contract and validation

`OutboxHandler.handle(message, cancellation): Promise<void>` resolves only after durable handling.
Message contains ID, store, topic, aggregate type/ID, parsed payload, attempt and idempotency key.
The structural cancellation object exposes `aborted`, `throwIfAborted()` and `onAbort(callback)`;
the callback registration returns an unsubscribe function. This keeps `packages/core` independent
of DOM/Worker types. An adapter can bridge cancellation to its network request's AbortController.

Supported topics are `order.confirmation.requested`, `order.confirmed` and `shipment.status`.
Order topics require aggregate type `order` and matching payload `orderId`; shipment topics
require `shipment` and matching `shipmentId`. IDs must be UUIDv7, store must be `para-main`,
payload must be a JSON object of at most 64 KiB, and attempts must be 1..5. Invalid jobs terminate
individually rather than stopping unrelated jobs. No customer payload is logged.

The deterministic fake can succeed, fail retryably, fail permanently or fail then succeed. It
records calls and simulated deliveries separately and deduplicates deliveries by idempotency key.
Its state is test-local: it is not a durable production delivery mechanism.

## Limits and retry policy

- At most **10 rows** per run, including cleanup of exhausted jobs. Smaller batches 1..10 are allowed.
- Two cleanup/selection queries plus at most two SQL queries per attempted job: up to 22 D1 queries.
- This leaves headroom under [D1's free-plan 50 queries per invocation](https://developers.cloudflare.com/d1/platform/limits/).
  A future handler and non-manual shipment poll share the invocation budget; budget their queries
  and CPU before enabling them. Current courier polling is skipped in manual mode.
- Handler timeout: **30 seconds**. Lease: **5 minutes**. Jobs are claimed one at a time immediately
  before delivery, so jobs waiting behind earlier attempts do not acquire premature leases.
- Attempts increment atomically on claim, including interrupted attempts. Maximum: **5**.
- Retry delays after attempts 1..4: **1, 2, 4, 8 minutes**, measured from completion time.
- Failed jobs with `next_attempt_at = NULL` are terminal and are not automatically retried.
- Pending jobs with no next time are immediately due; active leases and future retries are ignored.
- Expired processing jobs may be reclaimed. A crashed fifth attempt is converted to terminal failure.
- Existing tokenless processing rows are recoverable; existing failed/null-time rows require review.

`next_attempt_at` doubles as the lease deadline while processing. Migration **0006** adds only
nullable `claim_token`; it preserves existing jobs and the original four status values.

## Concurrency: what is and is not guaranteed

Selection alone is not ownership. The claim is one parameterized `UPDATE ... WHERE eligible ...
RETURNING` that rechecks due time, store, status and attempts at write time. Only the winning update
receives the claimed row. Each claim gets a random token. Success/failure updates require that exact
token, processing status and an unexpired lease. An old worker cannot overwrite the new owner's result.
These operations use [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/).

The delivery guarantee is **at least once**, not magically exactly once. If delivery succeeds but
the done acknowledgement fails, the row stays processing until lease recovery. A timeout also
signals cancellation, but an adapter that ignores cancellation may continue working. Therefore
every adapter must deduplicate effects with the stable key `outbox:<storeId>:<outboxId>`, including
across restarts and retries. An external provider must support that key or equivalent durable
recipient-side deduplication. A local database claim alone cannot prevent duplicate external effects
in the crash-after-send window.

## Failures and observability

`OutboxDeliveryError` exposes only allowlisted codes and a retryable flag:
`provider_unavailable`, `provider_rejected`, `unsupported_topic`, `invalid_payload`.
Generic throws become `delivery_failed`; timeouts become `handler_timeout`. No provider message,
stack trace, credential, email or phone is saved in `last_error` or emitted by the processor.

Structured `outbox_dispatch` logs contain allowlisted topic, validated aggregate ID, attempt,
result and sanitized error code. Unknown metadata is replaced with a placeholder. Logger failures
cannot turn a completed job into a failed delivery. Acknowledgement failure logs `persistence_failed`
and leaves the lease untouched so retry/recovery remains possible.

Summaries contain `processed`, `failed`, `skipped`: completed jobs, failures/terminal cleanup,
and lost claims/ownership respectively. Future or terminal jobs not selected are not counted as
skipped. Cron logs both subsystem summaries, even if one subsystem fails. `ctx.waitUntil` retains
the scheduled work as described in the [Worker scheduled-handler documentation](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/).

GET `/admin/outbox` is protected by Access and Worker JWT verification. It lists up to 25 recent
unfinished jobs, prioritizing failures, with a French terminal marker and masked legacy errors.
`Accept: application/json` returns the same monitoring fields. No payload, claim token, aggregate
customer data, or raw provider error is returned. Responses are private/no-store and vary on Access
identity and Accept. This page is read-only: manual retry/deletion and provider configuration are
out of scope.

## Verification

Core contract tests cover fake outcomes, idempotency, cancellation and exact backoff. D1 tests
use the real outbox schema and migration, including CHECK constraints and additive row preservation.
They cover concurrent claims, stale-owner fencing, retry boundaries, exhausted/crashed attempts,
unknown/malformed/oversized jobs, store isolation, maximum batch, failed acknowledgements,
timeouts, logger failure and private monitoring. All use fake handlers and controlled time;
no real WhatsApp/email delivery or production credentials are involved.
