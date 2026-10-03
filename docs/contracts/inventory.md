# Inventory movement ledger

Inventory is append-only. There is no mutable `stock` column and no workflow may overwrite a stock
number. The current quantity for a SKU is always derived from the ledger:

```sql
SELECT COALESCE(SUM(quantity), 0)
FROM inventory_movements
WHERE store_id = ? AND sku = ?;
```

## Fulfillment movements

- The first order transition to `SHIPPED` records one negative movement per distinct SKU.
- The transition to `RETURNED` records the corresponding positive movement.
- `DELIVERED` and `REFUSED` do not create another movement because the stock already left at
  `SHIPPED`.

Order items with the same SKU are aggregated before the movement is written. Fulfillment references
are stable (`order:<order-id>:shipped` and `order:<order-id>:returned`) and protected by a unique
index across store, SKU, reason, and reference.

The order update, order event, and inventory movement are submitted in one D1 batch. If any statement
fails, none of them commit. Replayed courier events are rejected by the webhook inbox and the unique
movement key provides a second idempotency barrier.
