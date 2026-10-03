// apps/api/test/statusSynchronization.spec.ts
import { createExecutionContext, env } from 'cloudflare:test';
import { courierSuccess, FakeCourierClient } from '@para/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MiddlewareHandler } from 'hono';

import type { AppBindings, AppEnvironment } from '../src/auth/cloudflareAccess';
import worker, { createApp, runShipmentStatusPoll } from '../src/index';
import { renderAdminOrdersPage } from '../src/modules/admin-orders/adminOrders.view';
import {
  ShipmentStatusTransitionError,
  synchronizeCourierStatus,
} from '../src/modules/status-sync/statusSync.service';
import { getStockBySku } from '../src/modules/inventory/inventory.service';
import { mapCourierStatus } from '../src/modules/status-sync/courierStatus.mapper';
import { pollOpenShipments } from '../src/modules/status-sync/statusPolling.service';

const TEST_SECRET = 'test-only-courier-webhook-secret-with-enough-entropy';
const CUSTOMER_ID = 'customer-1';
const ORDER_ID = '01995f0d-9b4d-7000-8000-000000000001';
const SHIPMENT_ID = '01995f0d-9b4d-7000-8000-000000000002';
const TRACKING_NUMBER = 'TRACK-101';
const SKU = 'BIO-OIL-125ML';
const OCCURRED_AT = '2026-10-03T12:00:00.000Z';

beforeEach(async () => resetDatabase('PACKED'));

const authenticatedAccess: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  context.set('accessIdentity', { email: 'admin@anfashpara.test', subject: 'admin' });
  await next();
};

describe('manual shipment workflow', () => {
  beforeEach(async () => {
    await env.DB.prepare('UPDATE shipments SET tracking_number = ? WHERE id = ?')
      .bind('SELF-PARA-101', SHIPMENT_ID)
      .run();
  });

  it('requires Access authentication before writing any state', async () => {
    const response = await createApp().request(
      manualUrl(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"action":"picked"}',
      },
      { ...env, CF_ACCESS_AUD: 'test', CF_ACCESS_TEAM_DOMAIN: 'anfashpara.cloudflareaccess.com' },
    );
    expect(response.status).toBe(401);
    expect(await rowCount('order_events')).toBe(0);
  });

  it('rejects a forged Access assertion before touching the database', async () => {
    const response = await createApp().request(
      manualUrl(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Jwt-Assertion': 'forged.token.value',
        },
        body: '{"action":"picked"}',
      },
      { ...env, CF_ACCESS_AUD: 'test', CF_ACCESS_TEAM_DOMAIN: 'anfashpara.cloudflareaccess.com' },
    );
    expect(response.status).toBe(401);
    expect(await rowCount('shipment_events')).toBe(0);
    expect(await readOrderStatus()).toBe('PACKED');
  });

  it('ships and delivers with a verified user actor, and replays have no effect', async () => {
    expect((await manualAction('picked')).status).toBe(200);
    expect(await readOrderStatus()).toBe('SHIPPED');
    expect(await getStockBySku(env.DB, SKU)).toBe(8);
    await expect((await manualAction('picked')).json()).resolves.toEqual({ duplicate: true });
    expect((await manualAction('delivered')).status).toBe(200);
    expect(await readOrderStatus()).toBe('DELIVERED');
    await expect((await manualAction('delivered')).json()).resolves.toEqual({ duplicate: true });
    // Replaying the earlier shipping action after delivery is also harmless.
    await expect((await manualAction('picked')).json()).resolves.toEqual({ duplicate: true });
    expect(await readCustomerCounters()).toEqual({ delivered_count: 1, refused_count: 0 });
    expect(await rowCount('shipment_events')).toBe(2);
    expect(await rowCount('order_events')).toBe(2);
    expect(await rowCount('inventory_movements')).toBe(2);
    const events = await env.DB.prepare('SELECT actor, reason FROM order_events').all();
    expect(events.results).toEqual([
      { actor: 'user:admin@anfashpara.test', reason: 'manual_picked' },
      { actor: 'user:admin@anfashpara.test', reason: 'manual_delivered' },
    ]);
  });

  it('refuses and returns a shipped parcel, restoring stock only once', async () => {
    await manualAction('picked');
    await manualAction('refused');
    expect(await getStockBySku(env.DB, SKU)).toBe(8);
    await manualAction('returned');
    await manualAction('returned');
    expect(await readOrderStatus()).toBe('RETURNED');
    expect(await getStockBySku(env.DB, SKU)).toBe(10);
    expect(await rowCount('order_events')).toBe(3);
    expect(await rowCount('shipment_events')).toBe(3);
    expect(await rowCount('inventory_movements')).toBe(3);
    expect(await readCustomerCounters()).toEqual({ delivered_count: 0, refused_count: 1 });
  });

  it('rejects skipped edges and conflicting outcomes with controlled 409 responses', async () => {
    expect((await manualAction('delivered')).status).toBe(409);
    expect((await manualAction('returned')).status).toBe(409);
    expect(await rowCount('webhook_inbox')).toBe(0);
    await manualAction('picked');
    await manualAction('delivered');
    expect((await manualAction('refused')).status).toBe(409);
    expect(await readOrderStatus()).toBe('DELIVERED');
  });

  it('validates IDs and actions and disallows SETTLED or caller-owned actors', async () => {
    expect((await manualAction('SETTLED')).status).toBe(400);
    expect((await manualAction('picked', { actor: 'system' })).status).toBe(400);
    const invalidId = await createApp(authenticatedAccess).request(
      manualUrl().replace(ORDER_ID, 'bad-id'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"action":"picked"}',
      },
      env,
    );
    expect(invalidId.status).toBe(400);
    const malformed = await createApp(authenticatedAccess).request(
      manualUrl(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      },
      env,
    );
    expect(malformed.status).toBe(400);
    expect(await rowCount('order_events')).toBe(0);
  });

  it('rejects mismatched order/shipment IDs, another store, and API-managed shipments', async () => {
    const otherId = '01995f0d-9b4d-7000-8000-000000000099';
    const response = await createApp(authenticatedAccess).request(
      manualUrl().replace(ORDER_ID, otherId),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"action":"picked"}',
      },
      env,
    );
    expect(response.status).toBe(404);
    await env.DB.prepare("UPDATE shipments SET tracking_number = 'TRACK-API'").run();
    expect((await manualAction('picked')).status).toBe(409);
    await env.DB.prepare("UPDATE shipments SET store_id = 'other-store'").run();
    expect((await manualAction('picked')).status).toBe(404);
  });

  it('rolls back events and shipment/order state when stock cannot commit', async () => {
    await env.DB.prepare('DROP TABLE inventory_movements').run();
    expect((await manualAction('picked')).status).toBe(503);
    expect(await readOrderStatus()).toBe('PACKED');
    expect(await rowCount('shipment_events')).toBe(0);
    expect(await rowCount('order_events')).toBe(0);
    expect(await rowCount('webhook_inbox')).toBe(0);
  });

  it('aborts a stale write if another operation changes state before the batch commits', async () => {
    const database = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE orders SET status = 'CANCELLED'").run();
        return env.DB.batch(statements);
      },
    } as D1Database;
    await expect(
      synchronizeCourierStatus(database, {
        source: 'manual',
        actor: 'user:admin@anfashpara.test',
        orderId: ORDER_ID,
        shipmentId: SHIPMENT_ID,
        eventId: 'race-event',
        normalizedStatus: 'picked',
        occurredAt: OCCURRED_AT,
        rawPayload: '{}',
        rawStatus: 'MANUAL_PICKED',
        trackingNumber: 'SELF-PARA-101',
      }),
    ).rejects.toBeInstanceOf(ShipmentStatusTransitionError);
    expect(await readOrderStatus()).toBe('CANCELLED');
    expect(await rowCount('shipment_events')).toBe(0);
    expect(await rowCount('inventory_movements')).toBe(1);
  });

  it('deduplicates simultaneous submissions atomically', async () => {
    const responses = await Promise.all([manualAction('picked'), manualAction('picked')]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await rowCount('order_events')).toBe(1);
    expect(await rowCount('shipment_events')).toBe(1);
    expect(await getStockBySku(env.DB, SKU)).toBe(8);
  });

  it('renders French form results privately and rejects foreign or missing form origins', async () => {
    const submit = (origin?: string) =>
      createApp(authenticatedAccess).request(
        manualUrl(),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(origin ? { Origin: origin } : {}),
          },
          body: 'action=picked',
        },
        env,
      );
    expect((await submit('https://evil.test')).status).toBe(403);
    expect((await submit()).status).toBe(403);
    const response = await submit('https://example.com');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(await response.text()).toContain('Statut du colis mis à jour.');
    const error = await createApp(authenticatedAccess).request(
      manualUrl(),
      {
        method: 'POST',
        headers: { Origin: 'https://example.com' },
        body: new URLSearchParams({ action: 'returned' }),
      },
      env,
    );
    expect(error.status).toBe(409);
    expect(await error.text()).toContain('Retour aux commandes');
  });

  it('shows only eligible manual actions in the mobile French queue', async () => {
    for (const [status, labels] of [
      ['PACKED', ['Remis / Expédié']],
      ['SHIPPED', ['Livré', 'Refusé']],
      ['REFUSED', ['Retourné']],
      ['DELIVERED', []],
    ] as const) {
      const page = String(
        await renderAdminOrdersPage({
          identityEmail: 'admin@test',
          now: new Date(),
          query: { q: '' },
          page: {
            nextCursor: null,
            orders: [
              {
                id: ORDER_ID,
                status,
                shipmentId: SHIPMENT_ID,
                shipmentManual: true,
                shipmentLabelAvailable: false,
                city: 'Rabat',
                codAmountCentimes: 100,
                customerName: 'Test',
                orderNumber: 'PARA-101',
                phoneE164: '+212612345678',
                placedAt: OCCURRED_AT,
                statusStartedAt: OCCURRED_AT,
              },
            ],
          },
        }),
      );
      for (const label of ['Remis / Expédié', 'Livré', 'Refusé', 'Retourné']) {
        expect(page.includes(`type="submit">${label}</button>`)).toBe(
          (labels as readonly string[]).includes(label),
        );
      }
      expect(page).toContain('name="viewport"');
    }
  });
});

function manualUrl() {
  return `https://example.com/admin/orders/${ORDER_ID}/shipments/${SHIPMENT_ID}/status`;
}
function manualAction(action: string, extra: Record<string, string> = {}) {
  return createApp(authenticatedAccess).request(
    manualUrl(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    },
    env,
  );
}

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
