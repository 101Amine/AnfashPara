// apps/api/test/statusSynchronization.spec.ts
import { createExecutionContext, env } from 'cloudflare:test';
import { courierSuccess, FakeCourierClient } from '@para/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppBindings } from '../src/auth/cloudflareAccess';
import worker, { runShipmentStatusPoll } from '../src/index';
import { getStockBySku } from '../src/modules/inventory/inventory.service';
import { mapCourierStatus } from '../src/modules/status-sync/courierStatus.mapper';
import { pollOpenShipments } from '../src/modules/status-sync/statusPolling.service';

const TEST_SECRET = 'test-only-courier-webhook-secret-with-enough-entropy';
const CUSTOMER_ID = 'customer-1';
const ORDER_ID = 'order-1';
const SHIPMENT_ID = 'shipment-1';
const TRACKING_NUMBER = 'TRACK-101';
const SKU = 'BIO-OIL-125ML';
const OCCURRED_AT = '2026-10-03T12:00:00.000Z';

beforeEach(async () => resetDatabase('PACKED'));

describe('courier status mapping', () => {
  it('normalizes common English and French statuses without accepting SETTLED', () => {
    expect(mapCourierStatus('OUT FOR DELIVERY')).toBe('out_for_delivery');
    expect(mapCourierStatus('Livré')).toBe('delivered');
    expect(mapCourierStatus('Refusé')).toBe('refused');
    expect(mapCourierStatus('Retourné')).toBe('returned');
    expect(mapCourierStatus('SETTLED')).toBeNull();
  });
});

describe('POST /api/webhooks/courier', () => {
  it('verifies the signature before parsing JSON', async () => {
    const response = await postWebhook('{not-json', 'sha256='.padEnd(71, '0'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_signature' },
    });
    await expect(rowCount('webhook_inbox')).resolves.toBe(0);
  });

  it('applies DELIVERED atomically and replaying the event has no effect', async () => {
    const rawPayload = webhookPayload('event-delivered', 'Livré');
    const signature = await sign(rawPayload);

    const first = await postWebhook(rawPayload, signature);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ duplicate: false, orderStatus: 'DELIVERED' });
    await expect(readOrderStatus()).resolves.toBe('DELIVERED');
    await expect(readCustomerCounters()).resolves.toEqual({ delivered_count: 1, refused_count: 0 });
    await expect(getStockBySku(env.DB, SKU)).resolves.toBe(8);
    await expect(readInventoryMovements()).resolves.toEqual([
      { quantity: 10, reason: 'purchase', reference: 'PO-TEST-1', sku: SKU },
      { quantity: -2, reason: 'shipped', reference: `order:${ORDER_ID}:shipped`, sku: SKU },
    ]);
    await expect(rowCount('shipment_events')).resolves.toBe(1);
    await expect(rowCount('order_events')).resolves.toBe(2);

    const replay = await postWebhook(rawPayload, signature);
    await expect(replay.json()).resolves.toEqual({ duplicate: true });
    await expect(readCustomerCounters()).resolves.toEqual({ delivered_count: 1, refused_count: 0 });
    await expect(getStockBySku(env.DB, SKU)).resolves.toBe(8);
    await expect(rowCount('inventory_movements')).resolves.toBe(2);
    await expect(rowCount('shipment_events')).resolves.toBe(1);
    await expect(rowCount('order_events')).resolves.toBe(2);
  });

  it('applies REFUSED and RETURNED using the guarded state machine', async () => {
    const refused = webhookPayload('event-refused', 'REFUSED');
    expect((await postWebhook(refused, await sign(refused))).status).toBe(200);
    await expect(readOrderStatus()).resolves.toBe('REFUSED');

    const returned = webhookPayload('event-returned', 'Retourné', '2026-10-03T13:00:00.000Z');
    expect((await postWebhook(returned, await sign(returned))).status).toBe(200);
    await expect(readOrderStatus()).resolves.toBe('RETURNED');
    await expect(readCustomerCounters()).resolves.toEqual({ delivered_count: 0, refused_count: 1 });
    await expect(getStockBySku(env.DB, SKU)).resolves.toBe(10);

    const events = await env.DB.prepare(
      'SELECT from_status, to_status, actor FROM order_events ORDER BY created_at, rowid',
    ).all();
    expect(events.results).toEqual([
      { actor: 'courier:test-courier', from_status: 'PACKED', to_status: 'SHIPPED' },
      { actor: 'courier:test-courier', from_status: 'SHIPPED', to_status: 'REFUSED' },
      { actor: 'courier:test-courier', from_status: 'REFUSED', to_status: 'RETURNED' },
    ]);
  });

  it('rolls back the order event when its inventory movement cannot commit', async () => {
    await env.DB.prepare('DROP TABLE inventory_movements').run();
    const rawPayload = webhookPayload('event-atomic-failure', 'DELIVERED');
    const response = await postWebhook(rawPayload, await sign(rawPayload));

    expect(response.status).toBe(503);
    await expect(readOrderStatus()).resolves.toBe('PACKED');
    await expect(rowCount('order_events')).resolves.toBe(0);
    await expect(rowCount('webhook_inbox')).resolves.toBe(0);
    await expect(rowCount('shipment_events')).resolves.toBe(0);
  });

  it('rejects SETTLED and never changes an order to that status', async () => {
    const rawPayload = webhookPayload('event-settled', 'SETTLED');
    const response = await postWebhook(rawPayload, await sign(rawPayload));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unsupported_status' },
    });
    await expect(readOrderStatus()).resolves.toBe('PACKED');
    await expect(rowCount('shipment_events')).resolves.toBe(0);
  });
});

describe('scheduled shipment polling fallback', () => {
  it('runs through the scheduled Worker path and uses replay-safe synchronization', async () => {
    const courierStatus = {
      occurredAt: OCCURRED_AT,
      rawStatus: 'DELIVERED',
      status: 'delivered' as const,
      trackingNumber: TRACKING_NUMBER,
    };
    const client = new FakeCourierClient({
      createParcel: courierSuccess({
        courier: 'test-courier',
        rawStatus: 'CREATED',
        status: 'created',
        trackingNumber: TRACKING_NUMBER,
      }),
      statuses: { [TRACKING_NUMBER]: courierSuccess(courierStatus) },
    });

    await expect(
      runShipmentStatusPoll({ ...env, COURIER_MODE: 'api' }, () => client),
    ).resolves.toEqual({
      failed: 0,
      processed: 1,
      skipped: 0,
    });
    await expect(readOrderStatus()).resolves.toBe('DELIVERED');
    expect(client.getStatusCalls).toEqual([TRACKING_NUMBER]);

    await env.DB.prepare("UPDATE shipments SET status_normalized = 'created' WHERE id = ?")
      .bind(SHIPMENT_ID)
      .run();
    await expect(pollOpenShipments(env.DB, client)).resolves.toEqual({
      failed: 0,
      processed: 0,
      skipped: 1,
    });
    await expect(rowCount('shipment_events')).resolves.toBe(1);
    await expect(readCustomerCounters()).resolves.toEqual({ delivered_count: 1, refused_count: 0 });
    await expect(getStockBySku(env.DB, SKU)).resolves.toBe(8);
  });

  it('does not poll operator-managed deliveries in manual mode', async () => {
    const client = new FakeCourierClient({
      createParcel: courierSuccess({
        courier: 'self-delivery',
        rawStatus: 'MANUAL_CREATED',
        status: 'created',
        trackingNumber: TRACKING_NUMBER,
      }),
      statuses: {},
    });

    await expect(
      runShipmentStatusPoll({ ...env, COURIER_MODE: 'manual' }, () => client),
    ).resolves.toEqual({
      failed: 0,
      processed: 0,
      reason: 'manual_mode',
      skipped: 0,
    });
    expect(client.getStatusCalls).toEqual([]);
  });
});

async function resetDatabase(orderStatus: string): Promise<void> {
  const statements = [
    'DROP TABLE IF EXISTS shipment_events',
    'DROP TABLE IF EXISTS shipments',
    'DROP TABLE IF EXISTS inventory_movements',
    'DROP TABLE IF EXISTS order_events',
    'DROP TABLE IF EXISTS order_items',
    'DROP TABLE IF EXISTS orders',
    'DROP TABLE IF EXISTS customers',
    'DROP TABLE IF EXISTS webhook_inbox',
    `CREATE TABLE customers (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, delivered_count INTEGER NOT NULL,
      refused_count INTEGER NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE orders (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      status TEXT NOT NULL, shipped_at TEXT, closed_at TEXT, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE order_items (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, order_id TEXT NOT NULL,
      sku TEXT NOT NULL, quantity INTEGER NOT NULL
    )`,
    `CREATE TABLE inventory_movements (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, sku TEXT NOT NULL,
      quantity INTEGER NOT NULL, reason TEXT NOT NULL, reference TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX inventory_store_sku_reason_reference_unique
      ON inventory_movements (store_id, sku, reason, reference)`,
    `CREATE TABLE shipments (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, order_id TEXT NOT NULL,
      courier TEXT NOT NULL, tracking_number TEXT NOT NULL, courier_status TEXT,
      status_normalized TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE shipment_events (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, shipment_id TEXT NOT NULL,
      courier_status TEXT NOT NULL, status_normalized TEXT NOT NULL,
      occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
    )`,
    `CREATE TABLE order_events (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, order_id TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL,
      reason TEXT, payload_json TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE webhook_inbox (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, source TEXT NOT NULL,
      external_event_id TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT,
      error TEXT, payload_json TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX webhook_inbox_store_source_event_unique
      ON webhook_inbox (store_id, source, external_event_id)`,
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO customers VALUES (?, ?, 0, 0, ?)').bind(
      CUSTOMER_ID,
      'para-main',
      '2026-10-03T00:00:00.000Z',
    ),
    env.DB.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, NULL, NULL, ?)').bind(
      ORDER_ID,
      'para-main',
      CUSTOMER_ID,
      orderStatus,
      '2026-10-03T00:00:00.000Z',
    ),
    env.DB.prepare('INSERT INTO order_items VALUES (?, ?, ?, ?, ?)').bind(
      'item-1',
      'para-main',
      ORDER_ID,
      SKU,
      2,
    ),
    env.DB.prepare('INSERT INTO inventory_movements VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      'movement-purchase-1',
      'para-main',
      SKU,
      10,
      'purchase',
      'PO-TEST-1',
      '2026-10-03T00:00:00.000Z',
    ),
    env.DB.prepare('INSERT INTO shipments VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      SHIPMENT_ID,
      'para-main',
      ORDER_ID,
      'test-courier',
      TRACKING_NUMBER,
      'CREATED',
      'created',
      '2026-10-03T00:00:00.000Z',
    ),
  ]);
}

function webhookPayload(eventId: string, status: string, occurredAt = OCCURRED_AT): string {
  return JSON.stringify({ eventId, occurredAt, status, trackingNumber: TRACKING_NUMBER });
}

async function postWebhook(rawPayload: string, signature: string): Promise<Response> {
  const bindings: AppBindings = { ...env, COURIER_WEBHOOK_SECRET: TEST_SECRET };
  return worker.fetch(
    new Request('https://example.com/api/webhooks/courier', {
      body: rawPayload,
      headers: { 'x-courier-signature': signature },
      method: 'POST',
    }),
    bindings,
    createExecutionContext(),
  );
}

async function sign(rawPayload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TEST_SECRET),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawPayload));
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256=${hex}`;
}

async function readOrderStatus(): Promise<string | undefined> {
  return (
    await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string }>()
  )?.status;
}

async function readCustomerCounters(): Promise<{
  delivered_count: number;
  refused_count: number;
} | null> {
  return env.DB.prepare('SELECT delivered_count, refused_count FROM customers WHERE id = ?')
    .bind(CUSTOMER_ID)
    .first();
}

async function readInventoryMovements(): Promise<
  { quantity: number; reason: string; reference: string; sku: string }[]
> {
  const result = await env.DB.prepare(
    'SELECT sku, quantity, reason, reference FROM inventory_movements ORDER BY created_at, rowid',
  ).all<{ quantity: number; reason: string; reference: string; sku: string }>();
  return result.results;
}

async function rowCount(table: string): Promise<number> {
  return (
    (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())
      ?.count ?? 0
  );
}
