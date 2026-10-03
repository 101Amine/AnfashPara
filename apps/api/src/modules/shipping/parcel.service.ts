// apps/api/src/modules/shipping/parcel.service.ts
import {
  transition,
  type Actor,
  type CourierClient,
  type CreateParcelInput,
  type Status,
} from '@para/core';

import { createUuidV7 } from '../../shared/uuidV7';

const STORE_ID = 'para-main';

type ParcelOrderRow = {
  address: string | null;
  city: string | null;
  cod_amount_centimes: number;
  customer_name: string | null;
  id: string;
  order_number: string | null;
  phone_e164: string;
  status: Status;
};

type ProductSummaryRow = {
  summary: string | null;
};

export type CreateParcelForOrderInput = {
  actor: Actor;
  orderId: string;
};

export type CreatedParcel = {
  courier: string;
  labelUrl?: string;
  orderStatus: 'PACKED' | 'SHIPPED';
  trackingNumber: string;
};

export class ParcelOrderNotFoundError extends Error {
  constructor() {
    super('Parcel order not found');
    this.name = 'ParcelOrderNotFoundError';
  }
}

export class ParcelAlreadyExistsError extends Error {
  constructor() {
    super('A parcel already exists for this order');
    this.name = 'ParcelAlreadyExistsError';
  }
}

export class ParcelOrderNotEligibleError extends Error {
  readonly status: Status;

  constructor(status: Status) {
    super(`Order status ${status} is not eligible for parcel creation`);
    this.name = 'ParcelOrderNotEligibleError';
    this.status = status;
  }
}

export class ParcelOrderDataInvalidError extends Error {
  constructor() {
    super('Order delivery data is incomplete');
    this.name = 'ParcelOrderDataInvalidError';
  }
}

export async function createParcelForOrder(
  database: D1Database,
  courierClient: CourierClient,
  input: CreateParcelForOrderInput,
  now = new Date(),
): Promise<CreatedParcel> {
  const order = await loadOrder(database, input.orderId);
  if (order === null) throw new ParcelOrderNotFoundError();

  const existingShipment = await database
    .prepare('SELECT id FROM shipments WHERE store_id = ? AND order_id = ? LIMIT 1')
    .bind(STORE_ID, order.id)
    .first<{ id: string }>();
  if (existingShipment !== null) throw new ParcelAlreadyExistsError();
  if (order.status !== 'CONFIRMED') throw new ParcelOrderNotEligibleError(order.status);

  const productSummary = await loadProductSummary(database, order.id);
  const parcelInput = toCreateParcelInput(order, productSummary);
  const packed = transition({ id: order.id, noAnswerAttempts: 0, status: order.status }, 'PACKED', {
    actor: input.actor,
    reason: 'parcel_created',
  });

  const parcel = await courierClient.createParcel(parcelInput);
  const timestamp = now.toISOString();
  const transitions = [packed.event];
  let finalStatus: 'PACKED' | 'SHIPPED' = 'PACKED';

  if (parcel.status === 'picked') {
    const shipped = transition(packed.next, 'SHIPPED', {
      actor: `courier:${parcel.courier}`,
      payload: { trackingNumber: parcel.trackingNumber },
      reason: 'courier_picked',
    });
    transitions.push(shipped.event);
    finalStatus = 'SHIPPED';
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO shipments
          (id, store_id, order_id, courier, tracking_number, courier_status, status_normalized,
           delivery_fee_centimes, return_fee_centimes, label_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        createUuidV7(now.getTime()),
        STORE_ID,
        order.id,
        parcel.courier,
        parcel.trackingNumber,
        parcel.rawStatus,
        parcel.status,
        parcel.deliveryFeeCentimes ?? null,
        parcel.returnFeeCentimes ?? null,
        parcel.labelUrl ?? null,
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        `UPDATE orders
         SET status = ?, shipped_at = CASE WHEN ? = 'SHIPPED' THEN ? ELSE shipped_at END,
             updated_at = ?
         WHERE id = ? AND store_id = ?`,
      )
      .bind(finalStatus, finalStatus, timestamp, timestamp, order.id, STORE_ID),
  ];

  for (const event of transitions) {
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
          order.id,
          event.fromStatus,
          event.toStatus,
          event.actor,
          event.reason ?? null,
          JSON.stringify({
            ...(event.payload ?? {}),
            courier: parcel.courier,
            trackingNumber: parcel.trackingNumber,
          }),
          timestamp,
        ),
    );
  }

  try {
    await database.batch(statements);
  } catch (error) {
    if (isDuplicateParcelError(error)) throw new ParcelAlreadyExistsError();
    throw error;
  }

  return {
    courier: parcel.courier,
    orderStatus: finalStatus,
    trackingNumber: parcel.trackingNumber,
    ...(parcel.labelUrl === undefined ? {} : { labelUrl: parcel.labelUrl }),
  };
}

async function loadOrder(database: D1Database, orderId: string): Promise<ParcelOrderRow | null> {
  return database
    .prepare(
      `SELECT o.id, o.order_number, o.status, o.cod_amount_centimes, o.city, o.address,
              c.name AS customer_name, c.phone_e164
       FROM orders o
       INNER JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ? AND o.store_id = ?
       LIMIT 1`,
    )
    .bind(orderId, STORE_ID)
    .first<ParcelOrderRow>();
}

async function loadProductSummary(database: D1Database, orderId: string): Promise<string> {
  const row = await database
    .prepare(
      `SELECT GROUP_CONCAT(oi.quantity || '× ' || p.name, ', ') AS summary
       FROM order_items oi
       INNER JOIN products p ON p.sku = oi.sku
       WHERE oi.store_id = ? AND oi.order_id = ?`,
    )
    .bind(STORE_ID, orderId)
    .first<ProductSummaryRow>();
  if (row?.summary === null || row?.summary === undefined || row.summary.trim() === '') {
    throw new ParcelOrderDataInvalidError();
  }
  return row.summary;
}

function toCreateParcelInput(order: ParcelOrderRow, productSummary: string): CreateParcelInput {
  if (
    order.order_number === null ||
    order.customer_name === null ||
    order.city === null ||
    order.address === null
  ) {
    throw new ParcelOrderDataInvalidError();
  }
  return {
    codAmountCentimes: order.cod_amount_centimes,
    idempotencyKey: order.id,
    orderId: order.id,
    orderReference: order.order_number,
    productSummary,
    receiver: {
      address: order.address,
      city: order.city,
      name: order.customer_name,
      phoneE164: order.phone_e164,
    },
  };
}

function isDuplicateParcelError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed: shipments.store_id, shipments.order_id')
  );
}
