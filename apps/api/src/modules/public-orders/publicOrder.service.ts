// apps/api/src/modules/public-orders/publicOrder.service.ts
import type { OrderWebhookPayload } from '../order-ingestion/orderWebhook.schema';
import {
  ingestOrderWebhook,
  OrderIngestionValidationError,
} from '../order-ingestion/orderWebhook.service';
import type { PublicOrderPayload } from './publicOrder.schema';

const STORE_ID = 'para-main';
const SOURCE = 'public-api';

type StoredOrder = {
  cod_amount_centimes: number;
  id: string;
  order_number: string;
};

type StoredRequest = {
  payload_json: string;
};

export type PublicOrderResult = {
  codAmountCentimes: number;
  currency: 'MAD';
  duplicate: boolean;
  orderId: string;
  orderNumber: string;
  status: 'CONFIRMING';
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export async function createPublicOrder(
  database: D1Database,
  idempotencyKey: string,
  payload: PublicOrderPayload,
  now = new Date(),
): Promise<PublicOrderResult> {
  const canonicalPayload = JSON.stringify(payload);
  const keyHash = await sha256(idempotencyKey);
  const externalId = `public-api:${keyHash}`;
  const orderNumber = `PARA-${keyHash.slice(0, 16).toUpperCase()}`;
  const existing = await loadExisting(database, idempotencyKey, externalId);

  if (existing !== null) {
    assertSamePayload(existing.request.payload_json, canonicalPayload);
    return toResult(existing.order, true);
  }

  const ingestionPayload: OrderWebhookPayload = {
    eventId: idempotencyKey,
    order: {
      attribution: payload.attribution,
      customer: payload.customer,
      externalId,
      items: payload.items,
      orderNumber,
      placedAt: now.toISOString(),
      shippingFeeCustomerCentimes: 0,
    },
  };

  const ingestionResult = await ingestOrderWebhook(
    database,
    canonicalPayload,
    ingestionPayload,
    now,
    SOURCE,
  );

  if (!ingestionResult.duplicate) {
    const order = await loadOrder(database, externalId);
    if (order === null) throw new Error('Created order could not be loaded');
    return toResult(order, false);
  }

  // Another request can win the unique constraint between our lookup and D1 batch.
  const raced = await loadExisting(database, idempotencyKey, externalId);
  if (raced === null) throw new Error('Duplicate order could not be loaded');
  assertSamePayload(raced.request.payload_json, canonicalPayload);
  return toResult(raced.order, true);
}

async function loadExisting(
  database: D1Database,
  idempotencyKey: string,
  externalId: string,
): Promise<{ order: StoredOrder; request: StoredRequest } | null> {
  const request = await database
    .prepare(
      `SELECT payload_json
       FROM webhook_inbox
       WHERE store_id = ? AND source = ? AND external_event_id = ?
       LIMIT 1`,
    )
    .bind(STORE_ID, SOURCE, idempotencyKey)
    .first<StoredRequest>();

  if (request === null) return null;

  const order = await loadOrder(database, externalId);
  if (order === null) throw new Error('Idempotency record has no order');
  return { order, request };
}

async function loadOrder(database: D1Database, externalId: string): Promise<StoredOrder | null> {
  return database
    .prepare(
      `SELECT id, order_number, cod_amount_centimes
       FROM orders
       WHERE store_id = ? AND external_id = ?
       LIMIT 1`,
    )
    .bind(STORE_ID, externalId)
    .first<StoredOrder>();
}

function assertSamePayload(storedPayload: string, requestPayload: string): void {
  if (storedPayload !== requestPayload) throw new IdempotencyConflictError();
}

function toResult(order: StoredOrder, duplicate: boolean): PublicOrderResult {
  return {
    codAmountCentimes: order.cod_amount_centimes,
    currency: 'MAD',
    duplicate,
    orderId: order.id,
    orderNumber: order.order_number,
    status: 'CONFIRMING',
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export { OrderIngestionValidationError };
