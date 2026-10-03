// apps/api/src/modules/shipping/manualFees.service.ts
import { createUuidV7 } from '../../shared/uuidV7';

type ShipmentFees = {
  order_id: string;
  status: string;
  tracking_number: string;
  delivery_fee_centimes: number | null;
  return_fee_centimes: number | null;
};

export class ManualFeesError extends Error {
  constructor(readonly code: 'not_found' | 'not_manual' | 'fees_locked' | 'stale_fees') {
    super(code);
    this.name = 'ManualFeesError';
  }
}

export async function loadManualFees(
  database: D1Database,
  shipmentId: string,
): Promise<ShipmentFees> {
  const shipment = await database
    .prepare(
      `SELECT s.order_id, o.status, s.tracking_number, s.delivery_fee_centimes, s.return_fee_centimes
     FROM shipments s JOIN orders o ON o.id = s.order_id AND o.store_id = s.store_id
     WHERE s.id = ? AND s.store_id = 'para-main'`,
    )
    .bind(shipmentId)
    .first<ShipmentFees>();
  if (!shipment) throw new ManualFeesError('not_found');
  if (!shipment.tracking_number.startsWith('SELF-')) throw new ManualFeesError('not_manual');
  return shipment;
}

export async function recordManualFees(
  database: D1Database,
  shipmentId: string,
  input: { deliveryFeeCentimes: number; returnFeeCentimes: number; reason: string },
  actor: string,
): Promise<{ duplicate: boolean }> {
  const previous = await loadManualFees(database, shipmentId);
  if (
    (previous.delivery_fee_centimes !== null &&
      previous.delivery_fee_centimes !== input.deliveryFeeCentimes) ||
    (previous.return_fee_centimes !== null &&
      previous.return_fee_centimes !== input.returnFeeCentimes)
  )
    throw new ManualFeesError('fees_locked');
  if (previous.delivery_fee_centimes !== null && previous.return_fee_centimes !== null) {
    if (
      previous.delivery_fee_centimes === input.deliveryFeeCentimes &&
      previous.return_fee_centimes === input.returnFeeCentimes
    )
      return { duplicate: true };
    throw new ManualFeesError('fees_locked');
  }
  if (previous.status === 'SETTLED') throw new ManualFeesError('fees_locked');
  const timestamp = new Date().toISOString();
  try {
    await database.batch([
      // A stale snapshot inserts NULL into the NOT NULL event ID and rolls back the entire batch.
      database
        .prepare(
          `INSERT INTO order_events
         (id, store_id, order_id, from_status, to_status, actor, reason, payload_json, created_at)
         VALUES (CASE WHEN EXISTS (
           SELECT 1 FROM shipments s JOIN orders o ON o.id = s.order_id AND o.store_id = s.store_id
           WHERE s.id = ? AND s.store_id = 'para-main' AND o.status = ?
             AND s.delivery_fee_centimes IS ? AND s.return_fee_centimes IS ?
         ) THEN ? ELSE NULL END, 'para-main', ?, ?, ?, ?, 'manual_fees_recorded', ?, ?)`,
        )
        .bind(
          shipmentId,
          previous.status,
          previous.delivery_fee_centimes,
          previous.return_fee_centimes,
          createUuidV7(),
          previous.order_id,
          previous.status,
          previous.status,
          actor,
          JSON.stringify({
            shipmentId,
            reason: input.reason,
            previous: {
              deliveryFeeCentimes: previous.delivery_fee_centimes,
              returnFeeCentimes: previous.return_fee_centimes,
            },
            next: {
              deliveryFeeCentimes: input.deliveryFeeCentimes,
              returnFeeCentimes: input.returnFeeCentimes,
            },
          }),
          timestamp,
        ),
      database
        .prepare(
          `UPDATE shipments SET delivery_fee_centimes = ?, return_fee_centimes = ?, updated_at = ?
         WHERE id = ? AND store_id = 'para-main'`,
        )
        .bind(input.deliveryFeeCentimes, input.returnFeeCentimes, timestamp, shipmentId),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /NOT NULL constraint failed: order_events.id/u.test(error.message)
    )
      throw new ManualFeesError('stale_fees');
    throw error;
  }
  return { duplicate: false };
}
