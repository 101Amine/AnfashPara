import { createUuidV7 } from '../../shared/uuidV7';
import { readStockAvailability } from './stockAvailability.service';
import { reserveStockStatement } from './stockReservation.service';

const STORE = 'para-main';
const OPEN = "('CONFIRMING','NO_ANSWER','CONFIRMED','PACKED')";
export class ReservationReviewError extends Error {}
type Item = { sku: string; quantity: number };

export async function readReservationInventory(db: D1Database, after = '') {
  const rows = (
    await db
      .prepare(
        `SELECT p.sku,p.name,
    (SELECT COALESCE(SUM(quantity),0) FROM inventory_movements WHERE store_id=p.store_id AND sku=p.sku) AS physical,
    (SELECT COALESCE(SUM(quantity),0) FROM stock_reservations WHERE store_id=p.store_id AND sku=p.sku AND status='active') AS reserved,
    (SELECT COALESCE(SUM(MAX(0,oi.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r
        WHERE r.store_id=oi.store_id AND r.order_id=oi.order_id AND r.sku=oi.sku AND r.status='active'),0))),0)
      FROM (SELECT store_id,order_id,sku,SUM(quantity) AS quantity FROM order_items GROUP BY store_id,order_id,sku) oi
      JOIN orders o ON o.id=oi.order_id AND o.store_id=oi.store_id
      WHERE oi.store_id=p.store_id AND oi.sku=p.sku AND o.status IN ${OPEN}) AS unreserved
    FROM products p WHERE p.store_id=? AND p.sku>? ORDER BY p.sku LIMIT 51`,
      )
      .bind(STORE, after)
      .all<{ sku: string; name: string; physical: number; reserved: number; unreserved: number }>()
  ).results;
  return {
    stock: rows.slice(0, 50).map((r) => ({
      ...r,
      available: r.physical - r.reserved,
      afterReconciliation: r.physical - r.reserved - r.unreserved,
    })),
    next: rows.length > 50 ? rows[49]!.sku : null,
  };
}

export async function readUnreservedOrders(db: D1Database, after = '') {
  const rows = (
    await db
      .prepare(
        `SELECT o.id,o.order_number,o.status,
    (SELECT COUNT(*) FROM stock_reservations r WHERE r.store_id=o.store_id AND r.order_id=o.id) AS existingHolds
    FROM orders o WHERE o.store_id=? AND o.status IN ${OPEN} AND o.id>?
    AND (NOT EXISTS(SELECT 1 FROM order_items i WHERE i.store_id=o.store_id AND i.order_id=o.id)
      OR EXISTS(SELECT 1 FROM order_items i WHERE i.store_id=o.store_id AND i.order_id=o.id
        AND COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.store_id=i.store_id AND r.order_id=i.order_id AND r.sku=i.sku AND r.status='active'),0)
          <> (SELECT SUM(j.quantity) FROM order_items j WHERE j.store_id=i.store_id AND j.order_id=i.order_id AND j.sku=i.sku)))
    ORDER BY o.id LIMIT 21`,
      )
      .bind(STORE, after)
      .all<{ id: string; order_number: string | null; status: string; existingHolds: number }>()
  ).results;
  return { orders: rows.slice(0, 20), next: rows.length > 20 ? rows[19]!.id : null };
}

export async function previewReservationBackfill(db: D1Database, orderId: string) {
  const order = await db
    .prepare('SELECT id,status FROM orders WHERE store_id=? AND id=?')
    .bind(STORE, orderId)
    .first<{ id: string; status: string }>();
  if (!order) throw new ReservationReviewError('order_not_found');
  const items = (
    await db
      .prepare(
        `SELECT sku,SUM(quantity) AS quantity FROM order_items
    WHERE store_id=? AND order_id=? GROUP BY sku ORDER BY sku LIMIT 51`,
      )
      .bind(STORE, orderId)
      .all<Item>()
  ).results;
  const holds = await db
    .prepare('SELECT COUNT(*) AS n FROM stock_reservations WHERE store_id=? AND order_id=?')
    .bind(STORE, orderId)
    .first<number>('n');
  const lines = await Promise.all(
    items.map(async (item) => ({ ...item, ...(await readStockAvailability(db, STORE, item.sku)) })),
  );
  const eligible =
    ['CONFIRMING', 'NO_ANSWER', 'CONFIRMED', 'PACKED'].includes(order.status) &&
    holds === 0 &&
    items.length > 0 &&
    items.length <= 50;
  const ready =
    eligible && lines.every((i) => i.available !== undefined && i.available >= i.quantity);
  const snapshot = JSON.stringify({ order, holds, lines });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  const token = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return { order, lines, holds, eligible, ready, token };
}

async function alreadyApplied(db: D1Database, orderId: string, token: string) {
  return (
    (await db
      .prepare(
        `SELECT id FROM order_events WHERE store_id=? AND order_id=?
    AND reason='reservation_backfilled' AND payload_json=? LIMIT 1`,
      )
      .bind(STORE, orderId, JSON.stringify({ token }))
      .first()) !== null
  );
}

export async function applyReservationBackfill(
  db: D1Database,
  orderId: string,
  token: string,
  actor: string,
  now = new Date(),
) {
  if (!/^user:[^\s@]+@[^\s@]+$/u.test(actor)) throw new ReservationReviewError('invalid_actor');
  if (await alreadyApplied(db, orderId, token)) return { duplicate: true };
  const preview = await previewReservationBackfill(db, orderId);
  if (await alreadyApplied(db, orderId, token)) return { duplicate: true };
  if (preview.token !== token) throw new ReservationReviewError('review_changed');
  if (!preview.ready) throw new ReservationReviewError('review_blocked');
  // Recheck the reviewed order/items/balances inside the transaction, before any holds.
  const audit = db
    .prepare(
      `INSERT INTO order_events
    (id,store_id,order_id,from_status,to_status,actor,reason,payload_json,created_at)
    VALUES (?,?,?,?,?,CASE WHEN
      (SELECT status FROM orders WHERE store_id=? AND id=?)=?
      AND NOT EXISTS(SELECT 1 FROM stock_reservations WHERE store_id=? AND order_id=?)
      AND (SELECT COUNT(DISTINCT sku) FROM order_items WHERE store_id=? AND order_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) line WHERE
        (SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE store_id=? AND order_id=? AND sku=json_extract(line.value,'$.sku'))<>json_extract(line.value,'$.quantity')
        OR (SELECT COALESCE(SUM(quantity),0) FROM inventory_movements WHERE store_id=? AND sku=json_extract(line.value,'$.sku'))<>json_extract(line.value,'$.physical')
        OR (SELECT COALESCE(SUM(quantity),0) FROM stock_reservations WHERE store_id=? AND sku=json_extract(line.value,'$.sku') AND status='active')<>json_extract(line.value,'$.reserved'))
      THEN ? ELSE NULL END,'reservation_backfilled',?,?)`,
    )
    .bind(
      createUuidV7(now.getTime()),
      STORE,
      orderId,
      preview.order.status,
      preview.order.status,
      STORE,
      orderId,
      preview.order.status,
      STORE,
      orderId,
      STORE,
      orderId,
      preview.lines.length,
      JSON.stringify(preview.lines),
      STORE,
      orderId,
      STORE,
      STORE,
      actor,
      JSON.stringify({ token }),
      now.toISOString(),
    );
  try {
    await db.batch([
      audit,
      ...preview.lines.map((i) =>
        reserveStockStatement(db, STORE, orderId, i.sku, i.quantity, now, actor),
      ),
    ]);
  } catch (error) {
    if (await alreadyApplied(db, orderId, token)) return { duplicate: true };
    if (
      error instanceof Error &&
      (error.message.includes('NOT NULL constraint failed: order_events.actor') ||
        error.message.includes('stock_reservations_quantity_valid') ||
        error.message.includes('reservation_already_exists'))
    ) {
      throw new ReservationReviewError('review_changed');
    }
    throw error;
  }
  return { duplicate: false };
}
