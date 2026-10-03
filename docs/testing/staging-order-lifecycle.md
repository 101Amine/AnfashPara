<!-- docs/testing/staging-order-lifecycle.md -->

# Staging order lifecycle test

This smoke test creates five synthetic orders against the deployed staging Worker and exercises:

1. delivered;
2. refused, then returned;
3. cancelled by the customer;
4. three no-answer attempts, ending in cancellation;
5. a delivered courier webhook replayed with the same event ID.

The generated order references start with `STG-`, use fictional customer data, and include the note
`Adresse test staging - ne pas livrer`. Never run this command against production.

## Required environment

```text
ORDER_WEBHOOK_SECRET=<same value as the staging Worker secret>
COURIER_WEBHOOK_SECRET=<same value as the staging Worker secret>
```

For a fully automated run, create a staging-only Cloudflare Access service token, allow it in the
staging Access application, and also provide:

```text
CF_ACCESS_CLIENT_ID=<staging service token ID>
CF_ACCESS_CLIENT_SECRET=<staging service token secret>
```

Without those two values, the runner pauses after ingestion. Complete the printed confirmation and
parcel actions in `/admin/orders`, then press Enter to continue the signed courier webhook phase.

Optional overrides:

```text
STAGING_BASE_URL=https://para-api-staging.alanfashpara.workers.dev
STAGING_TEST_SKU=VITC-1000-001
```

Run from the repository root:

```bash
pnpm --filter @para/api test:staging:lifecycle
```

Success requires final order statuses of `DELIVERED`, `RETURNED`, `CANCELLED`, `CANCELLED`, and
`DELIVERED`. The replay must return `{ "duplicate": true }` and must not create extra order,
shipment, inventory, or customer-counter effects.

Secrets belong in the shell environment and Cloudflare Worker secrets. They must never be placed in
this document, fixtures, command history, or Git.

## Verified run — 2026-10-03

The runner and protected admin UI were exercised against Worker version
`319d0819a7ee3856a0cec32f94271b9b2438d7b2` with run prefix `STG-20261003031847`.

| Case               | Final order status | Confirmation attempts | Shipment events | Inventory movements |
| ------------------ | ------------------ | --------------------- | --------------- | ------------------- |
| delivered          | `DELIVERED`        | 1                     | 1               | 1                   |
| refused-returned   | `RETURNED`         | 1                     | 2               | 2                   |
| customer-cancelled | `CANCELLED`        | 1                     | 0               | 0                   |
| three-no-answer    | `CANCELLED`        | 3                     | 0               | 0                   |
| duplicate-replay   | `DELIVERED`        | 2                     | 1               | 1                   |

The duplicate case had one earlier `callback` operator action and one `confirmed` action. This did
not affect replay verification: sending its identical courier event twice produced one inbox row,
one shipment event, and one inventory movement; the second response was `{ "duplicate": true }`.

The runner used temporary HMAC secrets for this execution. Both were removed afterward, restoring
staging to its previous Access-only secret configuration. The synthetic `STG-` rows remain in D1 as
reviewable evidence and are explicitly marked `ne pas livrer`.
