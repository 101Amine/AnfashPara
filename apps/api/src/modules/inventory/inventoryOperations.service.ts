// apps/api/src/modules/inventory/inventoryOperations.service.ts
import { createUuidV7 } from '../../shared/uuidV7';
import {
  inventoryOperationSchema,
  encodeInventoryCursor,
  type InventoryOperation,
  type InventoryCursor,
} from './inventoryOperations.schema';

const STORE = 'para-main';
export class InventoryOperationError extends Error {
  constructor(
    readonly code: 'invalid_operation' | 'invalid_actor' | 'sku_not_found' | 'reference_conflict',
  ) {
    super(code);
  }
}
export type InventoryHistoryRow = {
  id: string;
  sku: string;
  quantity: number;
  reason: string;
  reference: string | null;
  actor: string | null;
  note: string | null;
  created_at: string;
};

export async function recordInventoryOperation(
  database: D1Database,
  input: InventoryOperation,
  actor: string,
  now = new Date(),
) {
  const parsed = inventoryOperationSchema.safeParse(input);
  if (!parsed.success) throw new InventoryOperationError('invalid_operation');
  if (!/^user:[^\s@]+@[^\s@]+$/u.test(actor)) throw new InventoryOperationError('invalid_actor');
  const operation = parsed.data;
  const reference = `admin:${operation.reference}`;
  // Single conditional insert is atomic; unique reference arbitrates concurrent writers.
  const result = await database
    .prepare(
      `INSERT INTO inventory_movements
    (id,store_id,sku,quantity,reason,reference,operation_reason,actor,note,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM products WHERE store_id=? AND sku=?)
      ON CONFLICT(store_id,reference) WHERE operation_reason IS NOT NULL DO NOTHING RETURNING id`,
    )
    .bind(
      createUuidV7(now.getTime()),
      STORE,
      operation.sku,
      operation.quantity,
      operation.reason === 'expired' ? 'damaged' : operation.reason,
      reference,
      operation.reason,
      actor,
      operation.note,
      now.toISOString(),
      STORE,
      operation.sku,
    )
    .first<{ id: string }>();
  if (result) return { id: result.id, duplicate: false };
  const existing = await database
    .prepare(
      `SELECT id,sku,quantity,operation_reason,note FROM inventory_movements
    WHERE store_id=? AND reference=? AND operation_reason IS NOT NULL`,
    )
    .bind(STORE, reference)
    .first<{ id: string; sku: string; quantity: number; operation_reason: string; note: string }>();
  if (existing) {
    if (
      existing.sku !== operation.sku ||
      existing.quantity !== operation.quantity ||
      existing.operation_reason !== operation.reason ||
      existing.note !== operation.note
    )
      throw new InventoryOperationError('reference_conflict');
    // The original actor/time are preserved even if another authenticated admin replays.
    return { id: existing.id, duplicate: true };
  }
  throw new InventoryOperationError('sku_not_found');
}

export async function readInventoryOperations(
  database: D1Database,
  sku?: string,
  cursor?: InventoryCursor,
) {
  const stock = (
    await database
      .prepare(
        `SELECT p.sku,p.name,COALESCE(SUM(m.quantity),0) AS quantity
    FROM products p LEFT JOIN inventory_movements m ON m.store_id=p.store_id AND m.sku=p.sku
    WHERE p.store_id=? ${sku ? 'AND p.sku=?' : ''} GROUP BY p.sku,p.name ORDER BY p.sku LIMIT 50`,
      )
      .bind(...(sku ? [STORE, sku] : [STORE]))
      .all<{ sku: string; name: string; quantity: number }>()
  ).results;
  if (sku && !stock.length) throw new InventoryOperationError('sku_not_found');
  const rows = sku
    ? (
        await database
          .prepare(
            `SELECT id,sku,quantity,COALESCE(operation_reason,reason) AS reason,
    reference,actor,note,created_at FROM inventory_movements WHERE store_id=? AND sku=?
    ${cursor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`,
          )
          .bind(
            ...(cursor
              ? [STORE, sku, cursor.createdAt, cursor.createdAt, cursor.id]
              : [STORE, sku]),
          )
          .all<InventoryHistoryRow>()
      ).results
    : [];
  const history = rows.slice(0, 20);
  const last = history.at(-1);
  return {
    stock,
    history,
    nextCursor:
      rows.length > 20 && last
        ? encodeInventoryCursor({ id: last.id, createdAt: last.created_at, sku: last.sku })
        : null,
  };
}
