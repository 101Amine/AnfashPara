// apps/api/src/modules/status-sync/statusSync.service.ts
import { transition, type Actor, type CourierStatusCode, type Status } from '@para/core';

import { createUuidV7 } from '../../shared/uuidV7';
import { createOrderInventoryMovementStatements } from '../inventory/inventory.service';

const STORE_ID = 'para-main';

type ShipmentOrderRow = {
  courier: string;
  customer_id: string;
  order_id: string;
  order_status: Status;
  shipment_id: string;
  status_normalized: CourierStatusCode;
};

type LatestShipmentEventRow = {
  occurred_at: string;
};

type StatusSyncFields = {
  eventId: string;
  normalizedStatus: CourierStatusCode;
  occurredAt: string;
  rawPayload: string;
  rawStatus: string;
  trackingNumber: string;
};

export type StatusSyncInput = StatusSyncFields &
  (
    | { source: 'poll' | 'webhook' }
    | { source: 'manual'; actor: `user:${string}`; orderId: string; shipmentId: string }
  );

export type StatusSyncResult = {
  duplicate: boolean;
  orderStatus?: Status;
  stale?: boolean;
};

export class ShipmentNotFoundError extends Error {
  constructor() {
    super('Shipment not found');
    this.name = 'ShipmentNotFoundError';
  }
}

export class ShipmentStatusTransitionError extends Error {
  constructor() {
    super('Courier status is incompatible with the current order state');
    this.name = 'ShipmentStatusTransitionError';
  }
}

export async function synchronizeCourierStatus(
  database: D1Database,
  input: StatusSyncInput,
  now = new Date(),
): Promise<StatusSyncResult> {
  const shipment = await loadShipment(database, input.trackingNumber);
  if (shipment === null) throw new ShipmentNotFoundError();
  if (
    input.source === 'manual' &&
    (shipment.order_id !== input.orderId || shipment.shipment_id !== input.shipmentId)
  ) {
    throw new ShipmentNotFoundError();
  }

  const inboxSource = `courier-${input.source}:${shipment.courier}`;
  if (await inboxEventExists(database, inboxSource, input.eventId)) {
    return { duplicate: true };
  }

  // An operator must explicitly follow each edge; courier notifications may skip edges.
  if (input.source === 'manual') {
    const target = orderTargetFor(input.normalizedStatus);
    if (target === null || target === shipment.order_status) return { duplicate: true };
    try {
      transition(
        { id: shipment.order_id, status: shipment.order_status, noAnswerAttempts: 0 },
        target,
        { actor: input.actor },
      );
    } catch {
      throw new ShipmentStatusTransitionError();
    }
  }

  const latestEvent = await loadLatestShipmentEvent(database, shipment.shipment_id);
  const stale =
    input.source !== 'manual' && latestEvent !== null && input.occurredAt < latestEvent.occurred_at;
  const timestamp = now.toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO webhook_inbox
          (id, store_id, source, external_event_id, received_at, processed_at, error, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        createUuidV7(now.getTime()),
        STORE_ID,
        inboxSource,
        input.eventId,
        timestamp,
        timestamp,
        input.rawPayload,
      ),
    database
      .prepare(
        `INSERT INTO shipment_events
          (id, store_id, shipment_id, courier_status, status_normalized, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        createUuidV7(now.getTime()),
        STORE_ID,
        shipment.shipment_id,
        input.rawStatus,
        input.normalizedStatus,
        input.occurredAt,
        input.rawPayload,
      ),
  ];

  if (!stale) {
    // A NOT NULL failure aborts the entire D1 batch if another action won the race.
    statements[0] = database
      .prepare(
        `INSERT INTO webhook_inbox
        (id, store_id, source, external_event_id, received_at, processed_at, error, payload_json)
       VALUES (?, ?, CASE WHEN
         (SELECT status FROM orders WHERE id = ? AND store_id = ?) = ?
         THEN ? ELSE NULL END, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        createUuidV7(now.getTime()),
        STORE_ID,
        shipment.order_id,
        STORE_ID,
        shipment.order_status,
        inboxSource,
        input.eventId,
        timestamp,
        timestamp,
        input.rawPayload,
      );
  }

  if (stale) {
    const duplicate = await executeBatch(database, statements, inboxSource, input.eventId);
    return duplicate
      ? { duplicate: true }
      : { duplicate: false, orderStatus: shipment.order_status, stale: true };
  }

  statements.push(
    database
      .prepare(
        `UPDATE shipments
         SET courier_status = ?, status_normalized = ?, updated_at = ?
         WHERE id = ? AND store_id = ?`,
      )
      .bind(input.rawStatus, input.normalizedStatus, timestamp, shipment.shipment_id, STORE_ID),
  );

  const actor: Actor = input.source === 'manual' ? input.actor : `courier:${shipment.courier}`;
  const transitionEvents = buildTransitionEvents(
    shipment.order_id,
    shipment.order_status,
    input.normalizedStatus,
    actor,
    input,
  );
  const finalOrderStatus = transitionEvents.at(-1)?.toStatus ?? shipment.order_status;

  if (transitionEvents.length > 0) {
    statements.push(
      database
        .prepare(
          `UPDATE orders
           SET status = ?,
               shipped_at = CASE WHEN ? = 1 AND shipped_at IS NULL THEN ? ELSE shipped_at END,
               closed_at = CASE WHEN ? IN ('DELIVERED', 'REFUSED', 'RETURNED') THEN ? ELSE closed_at END,
               updated_at = ?
           WHERE id = ? AND store_id = ?`,
        )
        .bind(
          finalOrderStatus,
          transitionEvents.some((event) => event.toStatus === 'SHIPPED') ? 1 : 0,
          timestamp,
          finalOrderStatus,
          timestamp,
          timestamp,
          shipment.order_id,
          STORE_ID,
        ),
    );

    for (const event of transitionEvents) {
      statements.push(
        database
          .prepare(
            `INSERT INTO order_events
              (id, store_id, order_id, from_status, to_status, actor, reason, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            createUuidV7(now.getTime()),
            STORE_ID,
            shipment.order_id,
            event.fromStatus,
            event.toStatus,
            event.actor,
            event.reason ?? null,
            JSON.stringify(event.payload ?? {}),
            timestamp,
          ),
      );
    }

    if (transitionEvents.some((event) => event.toStatus === 'DELIVERED')) {
      statements.push(
        database
          .prepare(
            `UPDATE customers
             SET delivered_count = delivered_count + 1, updated_at = ?
             WHERE id = ? AND store_id = ?`,
          )
          .bind(timestamp, shipment.customer_id, STORE_ID),
      );
    }
    if (transitionEvents.some((event) => event.toStatus === 'REFUSED')) {
      statements.push(
        database
          .prepare(
            `UPDATE customers
             SET refused_count = refused_count + 1, updated_at = ?
             WHERE id = ? AND store_id = ?`,
          )
          .bind(timestamp, shipment.customer_id, STORE_ID),
      );
    }

    if (transitionEvents.some((event) => event.toStatus === 'SHIPPED')) {
      statements.push(
        ...(await createOrderInventoryMovementStatements(database, {
          occurredAt: timestamp,
          orderId: shipment.order_id,
          reason: 'shipped',
        })),
      );
    }
    if (transitionEvents.some((event) => event.toStatus === 'RETURNED')) {
      statements.push(
        ...(await createOrderInventoryMovementStatements(database, {
          occurredAt: timestamp,
          orderId: shipment.order_id,
          reason: 'returned',
        })),
      );
    }
  }

  const duplicate = await executeBatch(database, statements, inboxSource, input.eventId);
  return duplicate ? { duplicate: true } : { duplicate: false, orderStatus: finalOrderStatus };
}

async function loadShipment(
  database: D1Database,
  trackingNumber: string,
): Promise<ShipmentOrderRow | null> {
  return database
    .prepare(
      `SELECT s.id AS shipment_id, s.courier, s.status_normalized,
              o.id AS order_id, o.status AS order_status, o.customer_id
       FROM shipments s
       INNER JOIN orders o ON o.id = s.order_id
       WHERE s.store_id = ? AND s.tracking_number = ?
       LIMIT 1`,
    )
    .bind(STORE_ID, trackingNumber)
    .first<ShipmentOrderRow>();
}

async function inboxEventExists(
  database: D1Database,
  source: string,
  eventId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT id FROM webhook_inbox
       WHERE store_id = ? AND source = ? AND external_event_id = ?
       LIMIT 1`,
    )
    .bind(STORE_ID, source, eventId)
    .first<{ id: string }>();
  return row !== null;
}

async function loadLatestShipmentEvent(
  database: D1Database,
  shipmentId: string,
): Promise<LatestShipmentEventRow | null> {
  return database
    .prepare(
      `SELECT occurred_at FROM shipment_events
       WHERE shipment_id = ?
       ORDER BY occurred_at DESC
       LIMIT 1`,
    )
    .bind(shipmentId)
    .first<LatestShipmentEventRow>();
}

function buildTransitionEvents(
  orderId: string,
  currentStatus: Status,
  courierStatus: CourierStatusCode,
  actor: Actor,
  input: StatusSyncInput,
) {
  const target = orderTargetFor(courierStatus);
  if (target === null || hasReachedTarget(currentStatus, target)) return [];

  const path = input.source === 'manual' ? [target] : transitionPath(currentStatus, target);
  let order = { id: orderId, noAnswerAttempts: 0, status: currentStatus };

  try {
    return path.map((nextStatus) => {
      const result = transition(order, nextStatus, {
        actor,
        payload: {
          courierEventId: input.eventId,
          rawStatus: input.rawStatus,
          trackingNumber: input.trackingNumber,
        },
        reason: `${input.source === 'manual' ? 'manual' : 'courier'}_${input.normalizedStatus}`,
      });
      order = result.next;
      return result.event;
    });
  } catch {
    throw new ShipmentStatusTransitionError();
  }
}

function orderTargetFor(status: CourierStatusCode): Status | null {
  if (status === 'picked' || status === 'in_transit' || status === 'out_for_delivery') {
    return 'SHIPPED';
  }
  if (status === 'delivered') return 'DELIVERED';
  if (status === 'refused') return 'REFUSED';
  if (status === 'returned') return 'RETURNED';
  return null;
}

function hasReachedTarget(current: Status, target: Status): boolean {
  if (current === 'SETTLED') return true;
  if (current === target) return true;
  if (target === 'SHIPPED') {
    return ['DELIVERED', 'REFUSED', 'RETURNED'].includes(current);
  }
  if (target === 'REFUSED') return current === 'RETURNED';
  return false;
}

function transitionPath(current: Status, target: Status): Status[] {
  if (current === 'PACKED') {
    if (target === 'SHIPPED') return ['SHIPPED'];
    if (target === 'DELIVERED') return ['SHIPPED', 'DELIVERED'];
    if (target === 'REFUSED') return ['SHIPPED', 'REFUSED'];
    if (target === 'RETURNED') return ['SHIPPED', 'REFUSED', 'RETURNED'];
  }
  if (current === 'SHIPPED') {
    if (target === 'DELIVERED') return ['DELIVERED'];
    if (target === 'REFUSED') return ['REFUSED'];
    if (target === 'RETURNED') return ['REFUSED', 'RETURNED'];
  }
  if (current === 'REFUSED' && target === 'RETURNED') return ['RETURNED'];
  return [target];
}

async function executeBatch(
  database: D1Database,
  statements: D1PreparedStatement[],
  source: string,
  eventId: string,
): Promise<boolean> {
  try {
    await database.batch(statements);
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('NOT NULL constraint failed: webhook_inbox.source')
    ) {
      if (await inboxEventExists(database, source, eventId)) return true;
      throw new ShipmentStatusTransitionError();
    }
    if (
      error instanceof Error &&
      error.message.includes('UNIQUE constraint failed: webhook_inbox.store_id') &&
      (await inboxEventExists(database, source, eventId))
    ) {
      return true;
    }
    throw error;
  }
}
