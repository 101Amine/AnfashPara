// apps/api/test/orderWebhook.spec.ts
import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppBindings } from '../src/auth/cloudflareAccess';
import worker from '../src/index';

const TEST_SECRET = 'test-only-order-webhook-secret-with-enough-entropy';

const payload = {
  eventId: 'event-order-1001',
  order: {
    attribution: {
      utmCampaign: 'launch',
      utmContent: 'video-01',
      utmSource: 'instagram',
    },
    customer: {
      address: '12 rue Exemple, Agdal',
      city: 'Rabat',
      name: 'Salma Test',
      note: 'Appeler avant livraison',
      phone: '06 12 34 56 78',
    },
    externalId: 'storefront-order-1001',
    items: [
      { quantity: 2, sku: 'BIO-OIL-125ML' },
      { quantity: 1, sku: 'MUSTELA-250ML' },
    ],
    orderNumber: 'PARA-1001',
    placedAt: '2026-10-03T10:00:00.000Z',
    shippingFeeCustomerCentimes: 3000,
  },
} as const;

const resetDatabase = async (): Promise<void> => {
  if (!env.DB) throw new Error('The test D1 binding is missing');

  const statements = [
    'DROP TABLE IF EXISTS outbox',
    'DROP TABLE IF EXISTS order_events',
    'DROP TABLE IF EXISTS order_items',
    'DROP TABLE IF EXISTS orders',
    'DROP TABLE IF EXISTS customers',
    'DROP TABLE IF EXISTS webhook_inbox',
    'DROP TABLE IF EXISTS products',
    `CREATE TABLE products (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      cogs_centimes INTEGER NOT NULL,
      price_centimes INTEGER NOT NULL,
      compare_at_centimes INTEGER,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE UNIQUE INDEX products_sku_unique ON products (sku)',
    'CREATE UNIQUE INDEX products_store_sku_unique ON products (store_id, sku)',
    `CREATE TABLE webhook_inbox (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      source TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      error TEXT,
      payload_json TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX webhook_inbox_store_source_event_unique
      ON webhook_inbox (store_id, source, external_event_id)`,
    `CREATE TABLE customers (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      name TEXT,
      city TEXT,
      orders_count INTEGER NOT NULL,
      delivered_count INTEGER NOT NULL,
      refused_count INTEGER NOT NULL,
      blacklisted INTEGER NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE UNIQUE INDEX customers_store_phone_unique ON customers (store_id, phone_e164)',
    `CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      order_number TEXT,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL,
      cod_amount_centimes INTEGER NOT NULL,
      shipping_fee_customer_centimes INTEGER NOT NULL,
      city TEXT,
      address TEXT,
      note TEXT,
      utm_source TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      placed_at TEXT NOT NULL,
      confirmed_at TEXT,
      shipped_at TEXT,
      closed_at TEXT,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE UNIQUE INDEX orders_store_external_unique ON orders (store_id, external_id)',
    'CREATE UNIQUE INDEX orders_store_number_unique ON orders (store_id, order_number)',
    `CREATE TABLE order_items (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sku TEXT NOT NULL REFERENCES products(sku),
      quantity INTEGER NOT NULL,
      unit_price_centimes INTEGER NOT NULL,
      unit_cogs_centimes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE order_events (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE outbox (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT,
      last_error TEXT,
      processed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO products VALUES
      ('bio-oil', 'para-main', 'BIO-OIL-125ML', 'bio-oil', 'Bio Oil', NULL,
       4200, 8900, NULL, 1, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'),
      ('mustela', 'para-main', 'MUSTELA-250ML', 'mustela', 'Mustela', NULL,
       5100, 10900, NULL, 1, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`,
  ];

  for (const statement of statements) await env.DB.prepare(statement).run();
};

beforeEach(resetDatabase);

describe('POST /api/webhooks/orders', () => {
  it('rejects an invalid signature before attempting to parse JSON', async () => {
    const response = await postWebhook('{not-json', 'sha256='.padEnd(71, '0'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_signature', message: 'Invalid webhook signature' },
    });
    await expect(rowCount('webhook_inbox')).resolves.toBe(0);
  });

  it('rejects malformed JSON after accepting its signature', async () => {
    const rawPayload = '{not-json';
    const response = await postWebhook(rawPayload, await sign(rawPayload));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'malformed_payload', message: 'Malformed JSON payload' },
    });
    await expect(rowCount('webhook_inbox')).resolves.toBe(0);
  });

  it('returns a successful duplicate acknowledgement without writing twice', async () => {
    const rawPayload = JSON.stringify(payload);
    const signature = await sign(rawPayload);

    expect((await postWebhook(rawPayload, signature)).status).toBe(201);
    const duplicateResponse = await postWebhook(rawPayload, signature);

    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toEqual({ duplicate: true });
    await expect(rowCount('webhook_inbox')).resolves.toBe(1);
    await expect(rowCount('orders')).resolves.toBe(1);
    await expect(rowCount('order_items')).resolves.toBe(2);

    const customer = await env.DB.prepare('SELECT orders_count FROM customers WHERE phone_e164 = ?')
      .bind('+212612345678')
      .first<{ orders_count: number }>();
    expect(customer?.orders_count).toBe(1);
  });

  it('atomically creates the customer, priced order, transition event, inbox and outbox rows', async () => {
    const rawPayload = JSON.stringify(payload);
    const response = await postWebhook(rawPayload, await sign(rawPayload));

    expect(response.status).toBe(201);
    const body = await response.json<{ duplicate: false; orderId: string; status: string }>();
    expect(body).toMatchObject({ duplicate: false, status: 'CONFIRMING' });
    expect(body.orderId).toMatch(/^[0-9a-f-]{36}$/u);

    const customer = await env.DB.prepare(
      'SELECT phone_e164, name, city, orders_count FROM customers',
    ).first();
    expect(customer).toEqual({
      city: 'Rabat',
      name: 'Salma Test',
      orders_count: 1,
      phone_e164: '+212612345678',
    });

    const order = await env.DB.prepare(
      `SELECT status, cod_amount_centimes, shipping_fee_customer_centimes,
              utm_source, raw_payload_json
       FROM orders WHERE id = ?`,
    )
      .bind(body.orderId)
      .first();
    expect(order).toEqual({
      cod_amount_centimes: 31700,
      raw_payload_json: rawPayload,
      shipping_fee_customer_centimes: 3000,
      status: 'CONFIRMING',
      utm_source: 'instagram',
    });

    const items = await env.DB.prepare(
      'SELECT sku, quantity, unit_price_centimes, unit_cogs_centimes FROM order_items ORDER BY sku',
    ).all();
    expect(items.results).toEqual([
      {
        quantity: 2,
        sku: 'BIO-OIL-125ML',
        unit_cogs_centimes: 4200,
        unit_price_centimes: 8900,
      },
      {
        quantity: 1,
        sku: 'MUSTELA-250ML',
        unit_cogs_centimes: 5100,
        unit_price_centimes: 10900,
      },
    ]);

    await env.DB.prepare('UPDATE products SET price_centimes = 1, cogs_centimes = 1 WHERE sku = ?')
      .bind('BIO-OIL-125ML')
      .run();
    const frozenItem = await env.DB.prepare(
      'SELECT unit_price_centimes, unit_cogs_centimes FROM order_items WHERE sku = ?',
    )
      .bind('BIO-OIL-125ML')
      .first();
    expect(frozenItem).toEqual({ unit_cogs_centimes: 4200, unit_price_centimes: 8900 });

    const orderEvent = await env.DB.prepare(
      'SELECT from_status, to_status, actor, reason FROM order_events',
    ).first();
    expect(orderEvent).toEqual({
      actor: 'system',
      from_status: 'NEW',
      reason: 'order_ingested',
      to_status: 'CONFIRMING',
    });

    const inbox = await env.DB.prepare(
      'SELECT source, external_event_id, payload_json, processed_at FROM webhook_inbox',
    ).first<{ processed_at: string }>();
    expect(inbox).toMatchObject({
      external_event_id: payload.eventId,
      payload_json: rawPayload,
      source: 'storefront',
    });
    expect(inbox?.processed_at).toBeTruthy();

    const outbox = await env.DB.prepare(
      'SELECT topic, aggregate_type, aggregate_id, status, attempts FROM outbox',
    ).first();
    expect(outbox).toEqual({
      aggregate_id: body.orderId,
      aggregate_type: 'order',
      attempts: 0,
      status: 'pending',
      topic: 'order.confirmation.requested',
    });
  });
});

async function postWebhook(rawPayload: string, signature: string): Promise<Response> {
  const context = createExecutionContext();
  const bindings: AppBindings = {
    ...env,
    ORDER_WEBHOOK_SECRET: TEST_SECRET,
  };

  return worker.fetch(
    new Request('https://example.com/api/webhooks/orders', {
      body: rawPayload,
      headers: {
        'content-type': 'application/json',
        'x-para-signature': signature,
      },
      method: 'POST',
    }),
    bindings,
    context,
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

async function rowCount(table: string): Promise<number> {
  const result = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return result?.count ?? 0;
}
