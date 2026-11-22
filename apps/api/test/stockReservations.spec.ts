import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readStockAvailability } from '../src/modules/inventory/stockAvailability.service';
import resetSql from '../scripts/reset-local.sql?raw';
import { Hono } from 'hono';
import { createApp } from '../src/index';
import {
  applyReservationBackfill,
  previewReservationBackfill,
  readReservationInventory,
  readUnreservedOrders,
} from '../src/modules/inventory/reservationReview.service';
import type { AppEnvironment } from '../src/auth/cloudflareAccess';
import { registerPublicOrderRoutes } from '../src/modules/public-orders/publicOrder.routes';
import { registerOrderWebhookRoutes } from '../src/modules/order-ingestion/orderWebhook.routes';
import { performConfirmationAction } from '../src/modules/confirmation/confirmation.service';
import { createParcelForOrder } from '../src/modules/shipping/parcel.service';
import { ManualCourierClient } from '../src/integrations/courier/manualCourierClient';
import {
  synchronizeCourierStatus,
  type StatusSyncInput,
} from '../src/modules/status-sync/statusSync.service';

const migrations = import.meta.glob('../migrations/*.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;
const ts = '2026-11-22T12:00:00.000Z';
const later = '2026-11-23T12:00:00.000Z';
const id = (n: number) => `0199b001-1000-7000-8000-${String(n).padStart(12, '0')}`;

async function apply(sql: string) {
  for (const statement of sql.split('--> statement-breakpoint').filter((s) => s.trim())) {
    await env.DB.prepare(statement).run();
  }
}

async function seed(store = 'para-main', n = 1) {
  await env.DB.prepare(
    `INSERT INTO products(id,store_id,sku,slug,name,price_centimes,created_at,updated_at)
     VALUES (?,?,?,?,'Test',100,?,?)`,
  )
    .bind(`product-${n}`, store, `SKU-${n}`, `test-${n}`, ts, ts)
    .run();
  await env.DB.prepare(
    `INSERT INTO customers(id,store_id,phone_e164,created_at,updated_at) VALUES (?,?,?, ?,?)`,
  )
    .bind(id(n), store, `+21260000000${n}`, ts, ts)
    .run();
  await env.DB.prepare(
    `INSERT INTO orders(id,store_id,external_id,customer_id,status,cod_amount_centimes,
      placed_at,raw_payload_json,created_at,updated_at)
     VALUES (?,?,?,?,'CONFIRMING',100,?,'{}',?,?)`,
  )
    .bind(id(n + 10), store, `external-${n}`, id(n), ts, ts, ts)
    .run();
}

function hold(quantity: number | string = 1, order = id(11), sku = 'SKU-1', store = 'para-main') {
  return env.DB.prepare(
    `INSERT INTO stock_reservations
      (id,store_id,order_id,sku,quantity,created_at,created_by)
     VALUES (?,?,?,?,?,?,'system')`,
  ).bind(id(100), store, order, sku, quantity, ts);
}

beforeEach(async () => {
  for (const table of [
    'stock_reservations',
    'settlement_lines',
    'courier_settlements',
    'shipment_events',
    'shipments',
    'confirmation_attempts',
    'order_events',
    'order_items',
    'outbox',
    'webhook_inbox',
    'inventory_movements',
    'orders',
    'customers',
    'ad_spend_daily',
    'products',
    'settings',
  ])
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const [path, sql] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
    if (path.includes('/0008_')) await seed(); // Existing data must survive the additive migration.
    await apply(sql);
  }
});

describe('atomic checkout reservations', () => {
  const customer = {
    name: 'Test Customer',
    phone: '0612345678',
    city: 'Rabat',
    address: '12 Test Street',
  };
  const app = new Hono<AppEnvironment>();
  registerPublicOrderRoutes(app, { consume: () => ({ allowed: true }) });
  registerOrderWebhookRoutes(app);

  async function stock(quantity: number, sku = 'SKU-1', n = 200) {
    await env.DB.prepare(
      `INSERT INTO inventory_movements
      (id,store_id,sku,quantity,reason,reference,created_at)
      VALUES (?,'para-main',?,?,'adjustment',?,?)`,
    )
      .bind(id(n), sku, quantity, `opening-${n}`, ts)
      .run();
  }
  function checkout(key: string, items = [{ sku: 'SKU-1', quantity: 1 }], enabled = 'true') {
    return app.request(
      '/api/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ customer, items }),
      },
      { ...env, STOCK_RESERVATIONS_ENABLED: enabled },
    );
  }
  async function webhook(eventId: string) {
    const body = JSON.stringify({
      eventId,
      order: {
        customer,
        externalId: eventId,
        items: [{ sku: 'SKU-1', quantity: 1 }],
        placedAt: ts,
      },
    });
    const secret = 'test-reservation-webhook-secret';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    return app.request(
      '/api/webhooks/orders',
      { method: 'POST', headers: { 'X-Para-Signature': `sha256=${hex}` }, body },
      { ...env, ORDER_WEBHOOK_SECRET: secret, STOCK_RESERVATIONS_ENABLED: 'true' },
    );
  }
  async function count(table: string) {
    return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n');
  }

  it('reserves at checkout without changing physical stock and freezes database prices', async () => {
    await stock(2);
    const response = await checkout('success-key');
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ codAmountCentimes: 100, status: 'CONFIRMING' });
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 2,
      reserved: 1,
      available: 1,
    });
    expect(await count('order_events')).toBe(1);
    expect(await count('outbox')).toBe(1);
  });

  it('allows only one of two competing checkouts for the last unit', async () => {
    await stock(1);
    const responses = await Promise.all([checkout('last-unit-a'), checkout('last-unit-b')]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await responses.find((r) => r.status === 409)!.json()).toEqual({
      error: {
        code: 'insufficient_stock',
        message: 'One or more products have insufficient stock',
      },
    });
    expect(await count('stock_reservations')).toBe(1);
    expect(await count('webhook_inbox')).toBe(1);
    expect(await count('orders')).toBe(2); // Includes the pre-migration fixture order.
  });

  it('concurrent retries and later replay return the original order and one hold', async () => {
    await stock(1);
    const responses = await Promise.all([checkout('same-key-1'), checkout('same-key-1')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(
      responses.map((r) => r.json() as Promise<{ orderId: string }>),
    );
    expect(receipts[0].orderId).toBe(receipts[1].orderId);
    expect((await checkout('same-key-1')).status).toBe(200);
    expect((await checkout('same-key-1', [{ sku: 'SKU-1', quantity: 2 }])).status).toBe(409);
    expect(await count('stock_reservations')).toBe(1);
    expect(await count('order_events')).toBe(1);
    expect(await count('outbox')).toBe(1);
  });

  it('rolls back all items, holds, customer updates and inbox when a later SKU lacks stock', async () => {
    await seed('para-main', 2);
    await stock(1);
    const items = [
      { sku: 'SKU-1', quantity: 1 },
      { sku: 'SKU-2', quantity: 1 },
    ];
    expect((await checkout('multi-item-key', items)).status).toBe(409);
    for (const table of [
      'stock_reservations',
      'order_items',
      'order_events',
      'outbox',
      'webhook_inbox',
    ]) {
      expect(await count(table)).toBe(0);
    }
    expect(await count('customers')).toBe(2);
    expect(await count('orders')).toBe(2);
    await stock(1, 'SKU-2', 201);
    expect((await checkout('multi-item-key', items)).status).toBe(201);
    expect(await count('stock_reservations')).toBe(2);
  });

  it('shares the last unit across signed webhooks and public checkout, and deduplicates webhooks', async () => {
    await stock(1);
    expect((await webhook('signed-event')).status).toBe(201);
    expect((await checkout('public-after-hook')).status).toBe(409);
    expect(await (await webhook('signed-event')).json()).toEqual({ duplicate: true });
    expect((await webhook('another-signed-event')).status).toBe(409);
    expect(await count('stock_reservations')).toBe(1);
  });

  it('does not resurrect a closed hold when checkout is replayed', async () => {
    await stock(1);
    await checkout('closed-hold-key');
    await env.DB.prepare(
      `UPDATE stock_reservations SET status='released',closed_at=created_at,
      closed_by='system',close_reason='cancelled'`,
    ).run();
    expect((await checkout('closed-hold-key')).status).toBe(200);
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 1,
      reserved: 0,
      available: 1,
    });
    expect(await count('stock_reservations')).toBe(1);
  });

  it('rolls reservations back if writing a later event fails', async () => {
    await stock(1);
    await env.DB.prepare(
      `CREATE TRIGGER fail_event BEFORE INSERT ON order_events
      BEGIN SELECT RAISE(ABORT, 'test_audit_failure'); END`,
    ).run();
    expect((await checkout('audit-failure-key')).status).toBe(503);
    expect(await count('stock_reservations')).toBe(0);
    expect(await count('webhook_inbox')).toBe(0);
    expect(await count('orders')).toBe(1);
  });

  it('remains inactive unless explicitly enabled by the server', async () => {
    expect((await checkout('disabled-key', undefined, '')).status).toBe(201);
    expect(await count('stock_reservations')).toBe(0);
  });

  it('checks requested quantities rather than just whether any stock exists', async () => {
    await stock(2);
    expect((await checkout('too-many-units', [{ sku: 'SKU-1', quantity: 3 }])).status).toBe(409);
    expect((await checkout('exact-two-units', [{ sku: 'SKU-1', quantity: 2 }])).status).toBe(201);
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 2,
      reserved: 2,
      available: 0,
    });
  });

  async function reservedOrder() {
    await stock(2);
    const response = await checkout('lifecycle-order');
    expect(response.status).toBe(201);
    return ((await response.json()) as { orderId: string }).orderId;
  }
  const actor = 'user:admin@example.test' as const;
  function action(orderId: string, action: 'confirmed' | 'cancelled' | 'no_answer' | 'callback') {
    return performConfirmationAction(env.DB, { orderId, action, actor, channel: 'call' });
  }
  async function balance() {
    return readStockAvailability(env.DB, 'para-main', 'SKU-1');
  }
  async function packedOrder() {
    const orderId = await reservedOrder();
    await action(orderId, 'confirmed');
    const parcel = await createParcelForOrder(env.DB, new ManualCourierClient(), {
      orderId,
      actor,
    });
    const shipmentId = await env.DB.prepare('SELECT id FROM shipments WHERE order_id=?')
      .bind(orderId)
      .first<string>('id');
    const update = (
      status: StatusSyncInput['normalizedStatus'],
      eventId = `event-${status}`,
      source: 'manual' | 'webhook' | 'poll' = 'manual',
    ) =>
      synchronizeCourierStatus(env.DB, {
        source,
        actor,
        orderId,
        shipmentId: shipmentId!,
        trackingNumber: parcel.trackingNumber,
        normalizedStatus: status,
        rawStatus: status,
        rawPayload: '{}',
        eventId,
        occurredAt: new Date().toISOString(),
      });
    return { orderId, update };
  }

  it('cancellation releases once with the actor and reason, without a physical movement', async () => {
    const orderId = await reservedOrder();
    await action(orderId, 'cancelled');
    expect(await balance()).toEqual({ physical: 2, reserved: 0, available: 2 });
    expect(
      await env.DB.prepare('SELECT status,closed_by,close_reason FROM stock_reservations').first(),
    ).toEqual({
      status: 'released',
      closed_by: actor,
      close_reason: 'customer_cancelled',
    });
    await expect(action(orderId, 'cancelled')).rejects.toThrow();
    expect(await count('confirmation_attempts')).toBe(1);
    expect(await count('inventory_movements')).toBe(1);
  });

  it('keeps holds on callback and two no-answers, then releases on the third', async () => {
    const orderId = await reservedOrder();
    await action(orderId, 'callback');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await action(orderId, 'no_answer')).toEqual({ status: 'NO_ANSWER' });
      expect((await balance())?.reserved).toBe(1);
    }
    expect(await action(orderId, 'no_answer')).toEqual({ status: 'CANCELLED' });
    expect(
      await env.DB.prepare('SELECT status,close_reason FROM stock_reservations').first(),
    ).toEqual({ status: 'released', close_reason: 'no_answer' });
    expect((await balance())?.available).toBe(2);
  });

  it('allows only one concurrent cancel/confirm decision and keeps its hold consistent', async () => {
    const orderId = await reservedOrder();
    const results = await Promise.allSettled([
      action(orderId, 'cancelled'),
      action(orderId, 'confirmed'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count('confirmation_attempts')).toBe(1);
    const status = await env.DB.prepare('SELECT status FROM orders WHERE id=?')
      .bind(orderId)
      .first('status');
    expect((await balance())?.reserved).toBe(status === 'CANCELLED' ? 0 : 1);
  });

  it('rolls back cancellation, attempt and event if reservation closure fails', async () => {
    const orderId = await reservedOrder();
    await env.DB.prepare(
      `CREATE TRIGGER fail_closure BEFORE UPDATE ON stock_reservations
      BEGIN SELECT RAISE(ABORT, 'test_closure_failure'); END`,
    ).run();
    await expect(action(orderId, 'cancelled')).rejects.toThrow('test_closure_failure');
    expect(
      await env.DB.prepare('SELECT status FROM orders WHERE id=?').bind(orderId).first('status'),
    ).toBe('CONFIRMING');
    expect(await count('confirmation_attempts')).toBe(0);
    expect(await count('order_events')).toBe(1);
    expect((await balance())?.reserved).toBe(1);
  });

  it('keeps holds through packing, consumes on shipping, and restocks only on return', async () => {
    const { update } = await packedOrder();
    expect(await balance()).toEqual({ physical: 2, reserved: 1, available: 1 });
    await update('picked');
    expect(await balance()).toEqual({ physical: 1, reserved: 0, available: 1 });
    const closed = await env.DB.prepare(
      'SELECT status,closed_at,closed_by,close_reason FROM stock_reservations',
    ).first();
    expect(closed).toMatchObject({
      status: 'consumed',
      closed_by: actor,
      close_reason: 'manual_picked',
    });
    await update('picked');
    await update('picked', 'distinct-repeated-pick');
    await update('refused');
    expect((await balance())?.physical).toBe(1);
    await update('returned');
    await update('returned');
    expect(await balance()).toEqual({ physical: 2, reserved: 0, available: 2 });
    expect(
      await env.DB.prepare(
        'SELECT status,closed_at,closed_by,close_reason FROM stock_reservations',
      ).first(),
    ).toEqual(closed);
    expect(await count('inventory_movements')).toBe(3);
  });

  it.each(['webhook', 'poll'] as const)(
    'consumes holds when %s skips directly from packed to delivered',
    async (source) => {
      const { update } = await packedOrder();
      expect(await update('delivered', 'direct-delivery', source)).toMatchObject({
        orderStatus: 'DELIVERED',
      });
      await update('delivered', 'direct-delivery', source);
      expect(await balance()).toEqual({ physical: 1, reserved: 0, available: 1 });
      expect(await count('inventory_movements')).toBe(2);
      expect(
        await env.DB.prepare('SELECT status,closed_by FROM stock_reservations').first(),
      ).toEqual({ status: 'consumed', closed_by: 'courier:self-delivery' });
    },
  );

  it('rolls back shipping and consumed holds if the physical movement fails', async () => {
    const { orderId, update } = await packedOrder();
    await env.DB.prepare(
      `CREATE TRIGGER fail_shipped_movement BEFORE INSERT ON inventory_movements
      WHEN NEW.reason='shipped' BEGIN SELECT RAISE(ABORT, 'test_movement_failure'); END`,
    ).run();
    await expect(update('picked')).rejects.toThrow('test_movement_failure');
    expect(await balance()).toEqual({ physical: 2, reserved: 1, available: 1 });
    expect(
      await env.DB.prepare('SELECT status FROM orders WHERE id=?').bind(orderId).first('status'),
    ).toBe('PACKED');
    expect(await count('shipment_events')).toBe(0);
    expect(await count('webhook_inbox')).toBe(1);
    await env.DB.prepare('DROP TRIGGER fail_shipped_movement').run();
    await update('picked');
    expect(await balance()).toEqual({ physical: 1, reserved: 0, available: 1 });
  });

  it('consumes once when parcel creation immediately reports pickup; courier failure keeps the hold', async () => {
    const orderId = await reservedOrder();
    await action(orderId, 'confirmed');
    const manual = new ManualCourierClient();
    await expect(
      createParcelForOrder(
        env.DB,
        {
          createParcel: async () => {
            throw new Error('test_courier_unavailable');
          },
          getStatus: (tracking) => manual.getStatus(tracking),
        },
        { orderId, actor },
      ),
    ).rejects.toThrow('test_courier_unavailable');
    expect(await balance()).toEqual({ physical: 2, reserved: 1, available: 1 });
    const courier = {
      createParcel: async () => ({
        courier: 'test-courier',
        trackingNumber: 'TEST-PICKUP',
        rawStatus: 'picked',
        status: 'picked' as const,
      }),
      getStatus: (tracking: string) => manual.getStatus(tracking),
    };
    expect(await createParcelForOrder(env.DB, courier, { orderId, actor })).toMatchObject({
      orderStatus: 'SHIPPED',
    });
    await expect(createParcelForOrder(env.DB, courier, { orderId, actor })).rejects.toThrow();
    expect(await balance()).toEqual({ physical: 1, reserved: 0, available: 1 });
    expect(await count('inventory_movements')).toBe(2);
    expect(
      await env.DB.prepare('SELECT closed_by FROM stock_reservations').first('closed_by'),
    ).toBe('courier:test-courier');
  });

  it('concurrent shipment retries consume one hold and deduct once', async () => {
    const { update } = await packedOrder();
    const results = await Promise.allSettled([update('picked'), update('picked')]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await balance()).toEqual({ physical: 1, reserved: 0, available: 1 });
    expect(await count('inventory_movements')).toBe(2);
    expect(await count('shipment_events')).toBe(1);
  });

  it('does not allocate another store inventory or hide a physical shortfall', async () => {
    await env.DB.prepare(
      `INSERT INTO inventory_movements
      (id,store_id,sku,quantity,reason,reference,created_at)
      VALUES (?,'other','SKU-1',100,'adjustment','other-opening',?)`,
    )
      .bind(id(250), ts)
      .run();
    expect((await checkout('other-store-key')).status).toBe(409);
    await stock(-1);
    expect((await checkout('negative-stock-key')).status).toBe(409);
    expect(await count('stock_reservations')).toBe(0);
  });
});

describe('reservation reconciliation', () => {
  async function legacy(quantity = 2) {
    await env.DB.prepare(
      `INSERT INTO order_items(id,store_id,order_id,sku,quantity,unit_price_centimes,unit_cogs_centimes,created_at)
      VALUES (?,'para-main',?,'SKU-1',?,100,0,?)`,
    )
      .bind(id(400), id(11), quantity, ts)
      .run();
    await env.DB.prepare(
      `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
      VALUES (?,'para-main','SKU-1',3,'adjustment','legacy-opening',?)`,
    )
      .bind(id(401), ts)
      .run();
  }
  const actor = 'user:admin@example.test';
  it('shows physical, reserved, available and outstanding legacy quantities', async () => {
    await legacy(4);
    const data = await readReservationInventory(env.DB);
    expect(data.stock[0]).toMatchObject({
      physical: 3,
      reserved: 0,
      available: 3,
      unreserved: 4,
      afterReconciliation: -1,
    });
    expect((await readUnreservedOrders(env.DB)).orders).toHaveLength(1);
    const preview = await previewReservationBackfill(env.DB, id(11));
    expect(preview.ready).toBe(false);
    await expect(applyReservationBackfill(env.DB, id(11), preview.token, actor)).rejects.toThrow(
      'review_blocked',
    );
  });
  it('backfills all quantities once and preserves admin audit on concurrent retries', async () => {
    await legacy();
    const preview = await previewReservationBackfill(env.DB, id(11));
    const results = await Promise.all([
      applyReservationBackfill(env.DB, id(11), preview.token, actor),
      applyReservationBackfill(env.DB, id(11), preview.token, actor),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 3,
      reserved: 2,
      available: 1,
    });
    expect(
      await env.DB.prepare('SELECT created_by FROM stock_reservations').first('created_by'),
    ).toBe(actor);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM order_events').first('n')).toBe(1);
    expect((await readUnreservedOrders(env.DB)).orders).toHaveLength(0);
    await performConfirmationAction(env.DB, {
      orderId: id(11),
      action: 'cancelled',
      channel: 'call',
      actor: 'user:admin@example.test',
    });
    expect(await applyReservationBackfill(env.DB, id(11), preview.token, actor)).toEqual({
      duplicate: true,
    });
    expect((await readStockAvailability(env.DB, 'para-main', 'SKU-1'))?.reserved).toBe(0);
  });
  it.each(['stock', 'status', 'items'])(
    'rejects a stale preview after %s changes',
    async (change) => {
      await legacy();
      const preview = await previewReservationBackfill(env.DB, id(11));
      if (change === 'stock') await hold().run();
      if (change === 'status') await env.DB.prepare("UPDATE orders SET status='CONFIRMED'").run();
      if (change === 'items') await env.DB.prepare('UPDATE order_items SET quantity=1').run();
      await expect(applyReservationBackfill(env.DB, id(11), preview.token, actor)).rejects.toThrow(
        'review_changed',
      );
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM order_events').first('n')).toBe(0);
    },
  );
  it('flags partial/mismatched holds and empty orders instead of silently completing them', async () => {
    expect((await previewReservationBackfill(env.DB, id(11))).ready).toBe(false);
    await legacy();
    await hold().run();
    expect((await readUnreservedOrders(env.DB)).orders).toHaveLength(1);
    const preview = await previewReservationBackfill(env.DB, id(11));
    expect(preview.ready).toBe(false);
    await expect(applyReservationBackfill(env.DB, id(11), preview.token, actor)).rejects.toThrow(
      'review_blocked',
    );
  });
  it('rolls back the audit and earlier holds when any backfill insert fails', async () => {
    await legacy();
    await seed('para-main', 2);
    await env.DB.prepare(
      `INSERT INTO order_items(id,store_id,order_id,sku,quantity,unit_price_centimes,unit_cogs_centimes,created_at)
      VALUES (?,'para-main',?,'SKU-2',1,100,0,?)`,
    )
      .bind(id(402), id(11), ts)
      .run();
    await env.DB.prepare(
      `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
      VALUES (?,'para-main','SKU-2',1,'adjustment','second-opening',?)`,
    )
      .bind(id(403), ts)
      .run();
    const preview = await previewReservationBackfill(env.DB, id(11));
    await env.DB.prepare(
      `CREATE TRIGGER fail_backfill BEFORE INSERT ON stock_reservations WHEN NEW.sku='SKU-2' BEGIN SELECT RAISE(ABORT,'test_backfill_failure'); END`,
    ).run();
    await expect(applyReservationBackfill(env.DB, id(11), preview.token, actor)).rejects.toThrow(
      'test_backfill_failure',
    );
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM order_events').first('n')).toBe(0);
    expect((await readStockAvailability(env.DB, 'para-main', 'SKU-1'))?.reserved).toBe(0);
  });
  it('rejects a change occurring after preview validation but before the transaction', async () => {
    await legacy();
    const preview = await previewReservationBackfill(env.DB, id(11));
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare("UPDATE orders SET status='CANCELLED' WHERE id=?")
              .bind(id(11))
              .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(applyReservationBackfill(racingDb, id(11), preview.token, actor)).rejects.toThrow(
      'review_changed',
    );
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_reservations').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM order_events').first('n')).toBe(0);
  });
  it('paginates stock without repeating SKUs', async () => {
    await env.DB.batch(
      Array.from({ length: 51 }, (_, n) =>
        env.DB.prepare(
          `INSERT INTO products(id,store_id,sku,slug,name,price_centimes,created_at,updated_at)
      VALUES (?,'para-main',?,?,'Test',100,?,?)`,
        ).bind(`page-${n}`, `PAGE-${String(n).padStart(3, '0')}`, `page-${n}`, ts, ts),
      ),
    );
    const first = await readReservationInventory(env.DB);
    const second = await readReservationInventory(env.DB, first.next!);
    expect(first.stock).toHaveLength(50);
    expect(second.stock).toHaveLength(2);
    expect(new Set([...first.stock, ...second.stock].map((r) => r.sku)).size).toBe(52);
    expect(second.next).toBeNull();
  });
  it('protects the page, marks responses private and requires same-origin reviewed writes', async () => {
    await legacy();
    const anonymous = await createApp().request('/admin/inventory/reservations', {}, env);
    expect(anonymous.status).not.toBe(200);
    const app = createApp(async (c, next) => {
      c.set('accessIdentity', { email: 'admin@example.test', subject: 'test' });
      await next();
    });
    const response = await app.request('/admin/inventory/reservations', {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.text()).toContain('Stock et réservations');
    const preview = await previewReservationBackfill(env.DB, id(11));
    const body = JSON.stringify({ orderId: id(11), token: preview.token });
    expect(
      (
        await app.request(
          '/admin/inventory/reservations',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
          env,
        )
      ).status,
    ).toBe(403);
    const applied = await app.request(
      '/admin/inventory/reservations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'http://localhost',
        },
        body,
      },
      env,
    );
    expect(applied.status).toBe(201);
  });
});

describe('stock reservation database foundation', () => {
  it('supports the local reset script after reservation history exists', async () => {
    await hold().run();
    // Only the disposable test binding is reset, never the developer or remote DB.
    for (const statement of resetSql.split(';').filter((s) => s.trim())) {
      await env.DB.prepare(statement).run();
    }
    for (const [, sql] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
      await apply(sql);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_reservations').first('n')).toBe(0);
    await seed();
    await hold().run();
  });

  it('blocks REPLACE from deleting and recreating closed reservation history', async () => {
    await hold().run();
    await env.DB.prepare(
      `UPDATE stock_reservations SET status='released',closed_at=?,closed_by='system',close_reason='cancelled'`,
    )
      .bind(later)
      .run();
    for (const replacementId of [id(100), id(101)]) {
      await expect(
        env.DB.prepare(
          `INSERT OR REPLACE INTO stock_reservations(id,store_id,order_id,sku,quantity,created_at,created_by)
         VALUES (?,'para-main',?,'SKU-1',2,?,'system')`,
        )
          .bind(replacementId, id(11), ts)
          .run(),
      ).rejects.toThrow('reservation_already_exists');
    }
    expect(
      await env.DB.prepare('SELECT id,status,quantity FROM stock_reservations').first(),
    ).toEqual({ id: id(100), status: 'released', quantity: 1 });
  });

  it('preserves existing orders and does not backfill or change physical stock', async () => {
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_reservations').first('n')).toBe(0);
    await hold().run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n')).toBe(
      0,
    );
    expect(
      await env.DB.prepare('SELECT status, closed_at FROM stock_reservations').first(),
    ).toEqual({ status: 'active', closed_at: null });
  });

  it.each([0, -1, 1.5, 'invalid'])('rejects invalid quantity %s', async (quantity) => {
    await expect(hold(quantity).run()).rejects.toThrow('stock_reservations_quantity_valid');
  });

  it('enforces one hold per store/order/SKU even with another ID', async () => {
    await hold().run();
    await expect(
      env.DB.prepare(
        `INSERT INTO stock_reservations(id,store_id,order_id,sku,quantity,created_at,created_by)
       VALUES (?,'para-main',?,'SKU-1',1,?,'system')`,
      )
        .bind(id(101), id(11), ts)
        .run(),
    ).rejects.toThrow('reservation_already_exists');
  });

  it.each([
    [id(99), 'SKU-1', 'para-main'],
    [id(11), 'MISSING', 'para-main'],
    [id(12), 'SKU-1', 'para-main'],
    [id(11), 'SKU-2', 'para-main'],
  ])('rejects missing or cross-store parents: %s %s', async (order, sku, store) => {
    await seed('other', 2);
    await expect(hold(1, order, sku, store).run()).rejects.toThrow('FOREIGN KEY constraint failed');
  });

  it.each([
    ['bad-id', ts, 'system'],
    [id(100), 'not-a-date', 'system'],
    [id(100), ts, '   '],
  ])('requires valid acquisition metadata %s %s %s', async (reservationId, date, actor) => {
    await expect(
      env.DB.prepare(
        `INSERT INTO stock_reservations(id,store_id,order_id,sku,quantity,created_at,created_by)
       VALUES (?,'para-main',?,'SKU-1',1,?,?)`,
      )
        .bind(reservationId, id(11), date, actor)
        .run(),
    ).rejects.toThrow('CHECK constraint failed');
  });

  it('requires acquisition before closure and complete closure metadata', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO stock_reservations(id,store_id,order_id,sku,quantity,status,created_at,created_by,
        closed_at,closed_by,close_reason)
       VALUES (?,'para-main',?,'SKU-1',1,'released',?,'system',?,'system','cancelled')`,
      )
        .bind(id(100), id(11), ts, later)
        .run(),
    ).rejects.toThrow('reservation_must_start_active');
    await hold().run();
    for (const actor of [null, '', '   ']) {
      await expect(
        env.DB.prepare(
          `UPDATE stock_reservations SET status='released',closed_at=?,closed_by=?,close_reason='cancelled'`,
        )
          .bind(later, actor)
          .run(),
      ).rejects.toThrow('stock_reservations_closure_valid');
    }
  });

  it('reads physical/reserved/available separately, including real shortfalls', async () => {
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 0,
      reserved: 0,
      available: 0,
    });
    await env.DB.prepare(
      `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
       VALUES (?,'para-main','SKU-1',5,'purchase','opening',?)`,
    )
      .bind(id(200), ts)
      .run();
    await hold(2).run();
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 5,
      reserved: 2,
      available: 3,
    });
    await env.DB.prepare(
      `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
       VALUES (?,'para-main','SKU-1',-4,'damaged','loss',?)`,
    )
      .bind(id(201), ts)
      .run();
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 1,
      reserved: 2,
      available: -1,
    });
  });

  it.each(['released', 'consumed'])('excludes %s holds from reserved totals', async (status) => {
    await hold().run();
    await env.DB.prepare(
      `UPDATE stock_reservations SET status=?,closed_at=?,closed_by='system',close_reason='test'`,
    )
      .bind(status, later)
      .run();
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 0,
      reserved: 0,
      available: 0,
    });
  });

  it('does not leak cross-store stock and returns null for unknown products', async () => {
    await seed('other', 2);
    await hold(2, id(12), 'SKU-2', 'other').run();
    // The old ledger allows cross-store rows; the read model must ignore them.
    await env.DB.prepare(
      `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
       VALUES (?,'other','SKU-1',99,'purchase','foreign',?)`,
    )
      .bind(id(200), ts)
      .run();
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-1')).toEqual({
      physical: 0,
      reserved: 0,
      available: 0,
    });
    expect(await readStockAvailability(env.DB, 'para-main', 'SKU-2')).toBeNull();
    expect(await readStockAvailability(env.DB, 'para-main', 'MISSING')).toBeNull();
    expect(await readStockAvailability(env.DB, 'other', 'SKU-2')).toEqual({
      physical: 0,
      reserved: 2,
      available: -2,
    });
  });

  it.each(['released', 'consumed'])(
    'retains acquisition and terminal audit for %s',
    async (status) => {
      await hold().run();
      await env.DB.prepare(
        `UPDATE stock_reservations SET status=?,closed_at=?,closed_by=?,close_reason=? WHERE id=?`,
      )
        .bind(status, later, 'user:admin@example.test', `order_${status}`, id(100))
        .run();
      expect(
        await env.DB.prepare(
          'SELECT status,created_at,created_by,closed_at,closed_by,close_reason FROM stock_reservations',
        ).first(),
      ).toEqual({
        status,
        created_at: ts,
        created_by: 'system',
        closed_at: later,
        closed_by: 'user:admin@example.test',
        close_reason: `order_${status}`,
      });
      await expect(
        env.DB.prepare(
          `UPDATE stock_reservations SET status='active',closed_at=NULL,closed_by=NULL,close_reason=NULL`,
        ).run(),
      ).rejects.toThrow();
      await expect(
        env.DB.prepare(`UPDATE stock_reservations SET close_reason='rewritten'`).run(),
      ).rejects.toThrow();
    },
  );

  it.each([
    "status='invalid'",
    "status='released'",
    "closed_at='2026-11-23T12:00:00.000Z'",
    'quantity=2',
    "created_by='other'",
    "sku='MISSING'",
  ])('rejects invalid or rewritten holds: %s', async (assignment) => {
    await hold().run();
    await expect(
      env.DB.prepare(`UPDATE stock_reservations SET ${assignment}`).run(),
    ).rejects.toThrow();
  });

  it('rejects a closure dated before acquisition', async () => {
    await hold().run();
    await expect(
      env.DB.prepare(
        `UPDATE stock_reservations SET status='released',closed_at='2026-11-21T12:00:00.000Z',
       closed_by='system',close_reason='cancelled'`,
      ).run(),
    ).rejects.toThrow();
  });

  it('prevents deletion of hold history and its parent order', async () => {
    await hold().run();
    await expect(env.DB.prepare('DELETE FROM stock_reservations').run()).rejects.toThrow();
    await expect(env.DB.prepare('DELETE FROM orders').run()).rejects.toThrow();
  });

  it('rolls back an entire batch when a later hold is invalid', async () => {
    await expect(
      env.DB.batch([
        hold(),
        env.DB.prepare(
          `INSERT INTO stock_reservations(id,store_id,order_id,sku,quantity,created_at,created_by)
       VALUES (?,'para-main',?,'SKU-1',0,?,'system')`,
        ).bind(id(101), id(11), ts),
      ]),
    ).rejects.toThrow();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_reservations').first('n')).toBe(0);
  });
});
