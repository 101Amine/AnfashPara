# Staging reservation rollout

On 22 November 2026, seven eligible legacy staging orders were reviewed through
the protected admin UI. They now reserve eight units: MAG-001 (1), OMG3-001 (2),
VITC-1000-001 (2), VITD3-001 (1), ZINC-001 (2). Physical stock was unchanged.
[The independent audit](https://github.com/101Amine/AnfashPara/actions/runs/44976156356)
found no missing holds, shortages, mismatches or stranded reservations.

Automatic acquisition is enabled only in the staging Wrangler environment.
Production and local defaults remain disabled. Lifecycle release/consumption
continues even if acquisition is disabled again.

The manual `Staging lifecycle rehearsal` workflow requires the deployed merge SHA,
manual courier mode and reservation acquisition enabled before creating any orders.
It shares the deployment concurrency group to avoid a deployment during rehearsal.
Five signed synthetic order ingestions exercise the same reservation service used
by public checkout; this is not a browser checkout test.

Assertions cover:

- One active unit per new order and no physical movement.
- Exact order-event replay creates no second hold or other persisted changes.
- Confirmation and packing retain the hold; customer cancellation and the third
  no-answer release it.
- Manual handover consumes the hold and records one negative stock movement.
- Delivery keeps it consumed; refusal followed by return restores physical stock
  without recreating a hold.
- Duplicate courier delivery leaves all reported counts unchanged.
- Final archive accepts only completed synthetic runs with no active holds.
  It retains reservation/audit history and compensates synthetic physical movements.

If rehearsal fails, preserve its run reference and inspect the protected report.
Do not rerun blindly or cancel unrelated orders. Disable staging acquisition by
reverting its Wrangler flag if necessary, without deleting reservation history.
After a successful rehearsal, dispatch `Staging stock audit` again and confirm zero
missing, mismatched, stranded or short-stock counts before proceeding.
