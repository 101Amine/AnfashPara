import { createUuidV7 } from '../../shared/uuidV7';

export type ReservationOptions = { reserveStock?: boolean };

export class InsufficientStockError extends Error {
  constructor() {
    super('One or more products have insufficient stock');
    this.name = 'InsufficientStockError';
  }
}

// Must run in the order-creation batch, never as a separate write after checkout.
export function reserveStockStatement(
  database: D1Database,
  storeId: string,
  orderId: string,
  sku: string,
  quantity: number,
  now: Date,
  actor = 'system',
): D1PreparedStatement {
  return database
    .prepare(
      `
    INSERT INTO stock_reservations
      (id, store_id, order_id, sku, quantity, created_at, created_by)
    VALUES (?, ?, ?, ?, CASE WHEN
      (SELECT COALESCE(SUM(quantity), 0) FROM inventory_movements WHERE store_id=? AND sku=?)
      - (SELECT COALESCE(SUM(quantity), 0) FROM stock_reservations
         WHERE store_id=? AND sku=? AND status='active') >= ?
      THEN ? ELSE 0 END, ?, ?)
  `,
    )
    .bind(
      createUuidV7(now.getTime()),
      storeId,
      orderId,
      sku,
      storeId,
      sku,
      storeId,
      sku,
      quantity,
      quantity,
      now.toISOString(),
      actor,
    );
}

export function isStockGuardFailure(error: unknown): boolean {
  // Zero deliberately violates this named CHECK, rolling back the whole D1 batch.
  // INSERT ... SELECT ... WHERE would silently insert nothing and accept the order.
  return (
    error instanceof Error &&
    error.message.includes('CHECK constraint failed: stock_reservations_quantity_valid')
  );
}
