// apps/api/src/modules/order-ingestion/orderWebhook.service.ts
import { normalizeMoroccanMobile, transition } from '@para/core';

import { createUuidV7 } from '../../shared/uuidV7';
import type { OrderWebhookPayload } from './orderWebhook.schema';

const STORE_ID = 'para-main';
const WEBHOOK_SOURCE = 'storefront';

type ProductPrice = {
  active: number;
  cogs_centimes: number;
  price_centimes: number;
  sku: string;
};

export type OrderIngestionResult =
  { duplicate: true } | { duplicate: false; orderId: string; status: 'CONFIRMING' };

export class OrderIngestionValidationError extends Error {
  readonly code: 'invalid_phone' | 'unknown_product';

  constructor(code: OrderIngestionValidationError['code'], message: string) {
    super(message);
    this.name = 'OrderIngestionValidationError';
    this.code = code;
  }
}

export async function ingestOrderWebhook(
  database: D1Database,
  rawPayload: string,
  payload: OrderWebhookPayload,
  now = new Date(),
): Promise<OrderIngestionResult> {
  const duplicate = await database
    .prepare(
      'SELECT id FROM webhook_inbox WHERE store_id = ? AND source = ? AND external_event_id = ? LIMIT 1',
    )
    .bind(STORE_ID, WEBHOOK_SOURCE, payload.eventId)
    .first<{ id: string }>();

  if (duplicate !== null) {
    return { duplicate: true };
  }

  let phoneE164: string;
  try {
    phoneE164 = normalizeMoroccanMobile(payload.order.customer.phone);
  } catch {
    throw new OrderIngestionValidationError('invalid_phone', 'Invalid Moroccan mobile number');
  }

  const products = await loadProducts(
    database,
    payload.order.items.map(({ sku }) => sku),
  );
  const productBySku = new Map(products.map((product) => [product.sku, product]));
  const missingSku = payload.order.items.find(({ sku }) => {
    const product = productBySku.get(sku);
    return product === undefined || product.active !== 1;
  })?.sku;

  if (missingSku !== undefined) {
    throw new OrderIngestionValidationError(
      'unknown_product',
      `Product ${missingSku} is unavailable`,
    );
  }

  const timestamp = now.toISOString();
  const orderId = createUuidV7(now.getTime());
  const customerId = createUuidV7(now.getTime());
  const event = transition({ id: orderId, noAnswerAttempts: 0, status: 'NEW' }, 'CONFIRMING', {
    actor: 'system',
    payload: { externalEventId: payload.eventId },
    reason: 'order_ingested',
  }).event;
  const shippingFee = payload.order.shippingFeeCustomerCentimes;
  const itemsTotal = payload.order.items.reduce((total, item) => {
    const product = productBySku.get(item.sku)!;
    return total + product.price_centimes * item.quantity;
  }, 0);
  const codAmount = itemsTotal + shippingFee;
  const orderEventId = createUuidV7(now.getTime());
  const outboxId = createUuidV7(now.getTime());
  const inboxId = createUuidV7(now.getTime());

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO webhook_inbox
          (id, store_id, source, external_event_id, received_at, processed_at, error, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(inboxId, STORE_ID, WEBHOOK_SOURCE, payload.eventId, timestamp, timestamp, rawPayload),
    database
      .prepare(
        `INSERT INTO customers
          (id, store_id, phone_e164, name, city, orders_count, delivered_count, refused_count,
           blacklisted, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, ?, ?, ?)
         ON CONFLICT(store_id, phone_e164) DO UPDATE SET
           name = excluded.name,
           city = excluded.city,
           notes = COALESCE(excluded.notes, customers.notes),
           orders_count = customers.orders_count + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        customerId,
        STORE_ID,
        phoneE164,
        payload.order.customer.name,
        payload.order.customer.city,
        payload.order.customer.note ?? null,
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        `INSERT INTO orders
          (id, store_id, external_id, order_number, customer_id, status, cod_amount_centimes,
           shipping_fee_customer_centimes, city, address, note, utm_source, utm_campaign,
           utm_content, placed_at, confirmed_at, shipped_at, closed_at, raw_payload_json,
           created_at, updated_at)
         VALUES (?, ?, ?, ?,
           (SELECT id FROM customers WHERE store_id = ? AND phone_e164 = ?),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .bind(
        orderId,
        STORE_ID,
        payload.order.externalId,
        payload.order.orderNumber ?? null,
        STORE_ID,
        phoneE164,
        event.toStatus,
        codAmount,
        shippingFee,
        payload.order.customer.city,
        payload.order.customer.address,
        payload.order.customer.note ?? null,
        payload.order.attribution?.utmSource ?? null,
        payload.order.attribution?.utmCampaign ?? null,
        payload.order.attribution?.utmContent ?? null,
        payload.order.placedAt,
        rawPayload,
        timestamp,
        timestamp,
      ),
  ];

  for (const item of payload.order.items) {
    const product = productBySku.get(item.sku)!;
    statements.push(
      database
        .prepare(
          `INSERT INTO order_items
            (id, store_id, order_id, sku, quantity, unit_price_centimes, unit_cogs_centimes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          createUuidV7(now.getTime()),
          STORE_ID,
          orderId,
          item.sku,
          item.quantity,
          product.price_centimes,
          product.cogs_centimes,
          timestamp,
        ),
    );
  }

  statements.push(
    database
      .prepare(
        `INSERT INTO order_events
          (id, store_id, order_id, from_status, to_status, actor, reason, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        orderEventId,
        STORE_ID,
        orderId,
        event.fromStatus,
        event.toStatus,
        event.actor,
        event.reason ?? null,
        JSON.stringify(event.payload ?? {}),
        timestamp,
      ),
    database
      .prepare(
        `INSERT INTO outbox
          (id, store_id, topic, aggregate_type, aggregate_id, payload_json, status, attempts,
           next_attempt_at, last_error, processed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(
        outboxId,
        STORE_ID,
        'order.confirmation.requested',
        'order',
        orderId,
        JSON.stringify({ orderId, status: event.toStatus }),
        timestamp,
        timestamp,
      ),
  );

  try {
    // D1 executes a batch sequentially as one transaction and rolls it back if any statement fails.
    await database.batch(statements);
  } catch (error) {
    if (isDuplicateWebhookError(error)) {
      return { duplicate: true };
    }
    throw error;
  }

  return { duplicate: false, orderId, status: 'CONFIRMING' };
}

async function loadProducts(
  database: D1Database,
  skus: readonly string[],
): Promise<ProductPrice[]> {
  const placeholders = skus.map(() => '?').join(', ');
  const result = await database
    .prepare(
      `SELECT sku, price_centimes, cogs_centimes, active
       FROM products
       WHERE store_id = ? AND sku IN (${placeholders})`,
    )
    .bind(STORE_ID, ...skus)
    .all<ProductPrice>();

  return result.results;
}

function isDuplicateWebhookError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed: webhook_inbox.store_id')
  );
}
