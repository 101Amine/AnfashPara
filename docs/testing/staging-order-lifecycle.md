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

Both values are now mandatory. Authentication and manual-courier mode are checked before
ingestion; there is no Google prompt or interactive fallback. The target URL must match the
literal staging origin below. Alternate/production hosts are rejected before any request.

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

## Week 3 automation (#24) — verified on staging

The `Staging lifecycle rehearsal` workflow runs only on manual dispatch from `main`,
not on unit-test pushes or a schedule. It checks that the deployed SHA matches the
workflow revision before creating data. Its report appears in the GitHub job summary.
Concurrent workflow runs serialize; do not run an independent local rehearsal at
the same time. The runner fails closed on redirects, has request timeouts, never
prints raw HTTP responses/errors and uses a UUID run nonce in references.

### Deliberate one-time configuration

1. Create a service token named `Anfash staging lifecycle`, with a short expiry
   (30 days suggested). Keep its secret private; never paste it into this chat.
2. Add a **Service Auth**, not Bypass, policy to the **staging** Access application,
   including only that exact token. Preserve the existing human/email policy.
3. Set Worker staging secret `CF_ACCESS_STAGING_CLIENT_ID` to its client ID. The
   Worker verifies signature, issuer, AUD, expiry and signed `common_name`; it does
   not trust the client-ID header as identity. Production ignores this allowlist.
4. Store GitHub Actions secrets `STAGING_ACCESS_CLIENT_ID`,
   `STAGING_ACCESS_CLIENT_SECRET`, `STAGING_ORDER_WEBHOOK_SECRET` and
   `STAGING_COURIER_WEBHOOK_SECRET`. The latter two must match the corresponding
   staging Worker HMAC secrets. Do not reuse production credentials.
5. Merge/deploy the code, then dispatch the workflow. Check both final statuses
   and persisted counts in its redacted report before calling #24 complete.

User approval for the staging-only token/policy was recorded on 2026-10-03.
On that date the user created `Anfash staging lifecycle` with a one-year duration
(expiry 2027-10-03). The exact-token `Anfash staging lifecycle runner` Service Auth
policy was saved on `Anfash Para Admin (staging)`, alongside the unchanged human
policy; the protected hostname/path and 24-hour application session stayed unchanged.
Worker and GitHub secrets were configured with explicit user approval. They contain
staging-only credentials; no values were written to Git or this document. PR #34 was
merged and deployed as `41aa4d6f9d72ddf18193ee154b2a0a869584a5a1`.
The earlier Week 2 run above was interactive, not evidence of this automation.

### Live automation evidence — 2026-10-03

- [Initial successful run](https://github.com/101Amine/AnfashPara/actions/runs/37158925093),
  nonce `5a8bfdbf7425431fa64c634901373609`: all five cases passed, archive completed.
- [Denied run](https://github.com/101Amine/AnfashPara/actions/runs/37159064256),
  nonce `8f70d4826c3d4361856f54218d6405ec`: only the exact-token Service Auth grant was
  detached from the staging application; the runner failed and a read-only D1 count
  confirmed **zero orders** for that nonce. Human Google admin access remained usable.
- The original exact-token policy was restored, without changing the human policy.
  [Restored-policy run](https://github.com/101Amine/AnfashPara/actions/runs/37159329448),
  nonce `7f80ad054bc14145ae6043dbcda6dfcb`: passed and archived.

This proves revocation/restoration of the token's **application grant**, not permanent
destruction of the token resource. The resource remains active until its recorded
expiry or explicit revocation. Rotation/revocation procedure below still applies.

After merging the manual-fee/browser-policy fix, the
[post-fix run](https://github.com/101Amine/AnfashPara/actions/runs/37160308284)
passed and archived nonce `cf3b159d8c3941c48f6c110ed95d07f9` against deployed SHA
`52c63c62e01a779e8d7a54f85480e1f5bc961f8f`. This independently confirms the
restricted machine client still works after the browser form change.

| Case               | Final status | Attempts | Shipment events | Inventory movements | Order events |
| ------------------ | ------------ | -------- | --------------- | ------------------- | ------------ |
| delivered          | DELIVERED    | 1        | 2               | 1                   | 5            |
| refused-returned   | RETURNED     | 1        | 3               | 2                   | 6            |
| customer-cancelled | CANCELLED    | 1        | 0               | 0                   | 2            |
| three-no-answer    | CANCELLED    | 3        | 0               | 0                   | 4            |
| duplicate-replay   | DELIVERED    | 1        | 2               | 1                   | 5            |

Counts above are the asserted pre-archive report. Archiving appends compensation,
so retained post-archive inventory history has additional rows. Machine rehearsal
does not exercise public checkout, manual fee recording or settlement imports;
those belong to the separate Week 3 review.

Cloudflare's [application-token contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
documents service `common_name` and empty `sub`. The Worker keeps its human identity
contract, using the clearly synthetic `staging-runner@service.invalid` actor label
for existing domain services, with `kind: service` and the verified token ID as subject.
This is an adapter for automation, not a person authenticated through Google.

### Narrow Worker permissions

The service can read/post `/admin/testing/lifecycle` and POST confirmation, parcel,
and manual shipment actions **only** for orders matching all synthetic markers:
`STG-<32 lowercase hex nonce>-<1..5>`, matching `utm_campaign`,
`utm_source=staging-test`, the fictional address, and `note=STAGING_LIFECYCLE`.
General admin reads/writes and non-synthetic orders return 403. Service authentication
requires ENVIRONMENT staging and the exact staging hostname; it cannot select production.

The runner confirms/creates three parcels, explicitly hands them over through #18,
and then sends signed courier outcomes. The replay check compares persisted order,
shipment, inventory, inbox and customer-counter values before/after the same event.
Final status/attempt/event/movement counts are asserted, not left to human inspection.
The report endpoint is read-only and selects counts/IDs/status only, never phones,
addresses, customer names, secrets or payloads.

### Archive, failure evidence and revocation

On success the runner posts `{ "run": "<nonce>", "action": "archive" }` to the testing
endpoint with same-origin Origin. One D1 batch appends compensating inventory deltas,
marks unfinished synthetic order/shipment outbox jobs terminal, and tags orders
`STAGING_LIFECYCLE_ARCHIVED`. It does not delete order/event history or overwrite stock.
The stable per-run compensation reference prevents second effects. Archived synthetic
rows remain visible in staging aggregates: archive is not an analytics exclusion filter.
This assumes production notification dispatch remains paused and manual courier mode;
there is no real parcel or external notification delivery in this rehearsal.

Failure preserves the run and partial evidence; the runner prints the nonce and writes
a safe failure report, not raw exceptions. Do not blindly rerun actions against that
nonce; a fresh invocation gets a fresh nonce. After diagnosis a five-order run can be
archived by an authenticated admin with the same API; incomplete runs are deliberately
not bulk-cleaned by the endpoint. Never manually delete broad tables to clean a test.

Rotate by creating a replacement service token, updating the exact Access policy,
Worker client-ID allowlist and GitHub secret pair, and proving a run before revoking
the old token. To disable immediately, remove the Worker allowlist and revoke the
token or its policy. A request with revoked credentials should receive a controlled
403/401 (or Access denial/redirect); the runner fails preflight before ingestion.
Live denial after removal of the application grant is recorded above. Do not describe
it as a permanently deleted token or a production revocation test.
