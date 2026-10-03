# Courier status synchronization

Courier status updates enter through one shared service, whether they arrive from the signed webhook
or the scheduled polling fallback. That service owns deduplication, shipment updates, order state
transitions, customer counters, and event history.

## Signed webhook

`POST /api/webhooks/courier` requires `X-Courier-Signature` in the form
`sha256=<lowercase hex HMAC-SHA256>`. The HMAC covers the exact raw request body and uses the
`COURIER_WEBHOOK_SECRET` Worker secret. Verification happens before JSON parsing.

```json
{
  "eventId": "courier-event-123",
  "trackingNumber": "TRACK-101",
  "status": "DELIVERED",
  "occurredAt": "2026-10-03T12:00:00.000Z"
}
```

The pair `(courier source, eventId)` is unique in `webhook_inbox`. Replaying it returns
`200 { "duplicate": true }` and performs no additional write.

## Normalization and order transitions

The adapter accepts normalized English values and common French equivalents, including `Livré`,
`Refusé`, and `Retourné`. They map to the internal shipment statuses `delivered`, `refused`, and
`returned`.

All order changes pass through the core `transition()` state machine as `courier:<courier-name>`.
Courier events may produce `SHIPPED`, `DELIVERED`, `REFUSED`, and `RETURNED`. `SETTLED` is not a
courier status, is rejected by the mapper, and remains exclusive to reconciliation.

## Polling fallback

The Worker cron polls up to 50 open API-managed shipments, oldest first, through
`CourierClient.getStatus()`. Poll results use the same atomic synchronization service and a stable
synthetic event ID, so an identical result has no second effect. Terminal shipments are not polled.

`COURIER_MODE=manual` skips polling because self-deliveries require deliberate operator updates; it
does not invent a status for them.
