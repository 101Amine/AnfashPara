// apps/api/src/modules/inventory/inventory.service.ts
import { createUuidV7 } from '../../shared/uuidV7';

const STORE_ID = 'para-main';

type OrderItemQuantityRow = {
  quantity: number;
  sku: string;
};

export type InventoryMovementReason = 'returned' | 'shipped';

export class InventoryOrderItemsNotFoundError extends Error {
  constructor() {
    super('Order items are required for an inventory movement');
    this.name = 'InventoryOrderItemsNotFoundError';
  }
}

export async function createOrderInventoryMovementStatements(
  database: D1Database,
  input: {
    occurredAt: string;
    orderId: string;
    reason: InventoryMovementReason;
  },
): Promise<D1PreparedStatement[]> {
  const items = await database
    .prepare(
      `SELECT sku, SUM(quantity) AS quantity
       FROM order_items
       WHERE store_id = ? AND order_id = ?
       GROUP BY sku
       ORDER BY sku`,
    )
    .bind(STORE_ID, input.orderId)
    .all<OrderItemQuantityRow>();

  if (items.results.length === 0) throw new InventoryOrderItemsNotFoundError();

  const direction = input.reason === 'shipped' ? -1 : 1;
  const reference = `order:${input.orderId}:${input.reason}`;
  const timestamp = new Date(input.occurredAt).getTime();

  return items.results.map((item) =>
    database
      .prepare(
        `INSERT INTO inventory_movements
          (id, store_id, sku, quantity, reason, reference, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        createUuidV7(timestamp),
        STORE_ID,
        item.sku,
        direction * item.quantity,
        input.reason,
        reference,
        input.occurredAt,
      ),
  );
}

export async function getStockBySku(database: D1Database, sku: string): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS stock
       FROM inventory_movements
       WHERE store_id = ? AND sku = ?`,
    )
    .bind(STORE_ID, sku)
    .first<{ stock: number }>();

  return row?.stock ?? 0;
}
