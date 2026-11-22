export interface StockAvailability {
  physical: number;
  reserved: number;
  available: number;
}

// Internal read model only. A pre-read must never authorize a reservation;
// acquisition needs a guard inside the same transaction as order creation.
export async function readStockAvailability(
  database: D1Database,
  storeId: string,
  sku: string,
): Promise<StockAvailability | null> {
  const row = await database
    .prepare(
      `SELECT
       (SELECT COALESCE(SUM(m.quantity), 0) FROM inventory_movements m
        WHERE m.store_id = p.store_id AND m.sku = p.sku) AS physical,
       (SELECT COALESCE(SUM(r.quantity), 0) FROM stock_reservations r
        WHERE r.store_id = p.store_id AND r.sku = p.sku AND r.status = 'active') AS reserved
     FROM products p WHERE p.store_id = ? AND p.sku = ?`,
    )
    .bind(storeId, sku)
    .first<{ physical: number; reserved: number }>();
  // Negative availability exposes a shortfall instead of hiding a ledger discrepancy.
  return row === null ? null : { ...row, available: row.physical - row.reserved };
}
