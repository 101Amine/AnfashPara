// apps/api/test/createParcel.spec.ts
import { env } from 'cloudflare:test';
import { CourierClientError, type CreateParcelResult } from '@para/core';
import { FakeCourierClient, courierFailure, courierSuccess } from '@para/core/testing';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppBindings, AppEnvironment } from '../src/auth/cloudflareAccess';
import {
  CourierConfigurationError,
  HttpCourierClient,
  createCourierClientFromBindings,
} from '../src/integrations/courier/courierClient.factory';
import { ManualCourierClient } from '../src/integrations/courier/manualCourierClient';
import { createApp } from '../src/index';

const ORDER_ID = '0199b001-1000-7000-8000-000000000001';
const authenticatedAccess: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  context.set('accessIdentity', {
    email: 'admin@anfashpara.test',
    subject: 'admin-subject',
  });
  await next();
};
const bindings = (): AppBindings => ({ ...env });

const createdParcel: CreateParcelResult = {
  courier: 'fake-courier',
  deliveryFeeCentimes: 3_500,
  labelUrl: 'https://example.test/labels/TRACK-101.pdf',
  rawStatus: 'CREATED',
  returnFeeCentimes: 1_500,
  status: 'created',
  trackingNumber: 'TRACK-101',
};

beforeEach(async () => {
  if (!env.DB) throw new Error('The test D1 binding is missing');

  for (const statement of [
    'DROP TABLE IF EXISTS order_events',
    'DROP TABLE IF EXISTS shipments',
    'DROP TABLE IF EXISTS inventory_movements',
    'DROP TABLE IF EXISTS order_items',
    'DROP TABLE IF EXISTS orders',
    'DROP TABLE IF EXISTS customers',
    'DROP TABLE IF EXISTS products',
    `CREATE TABLE customers (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      name TEXT,
      city TEXT
    )`,
    `CREATE TABLE products (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    )`,
    `CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_number TEXT,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      cod_amount_centimes INTEGER NOT NULL,
      city TEXT,
      address TEXT,
      placed_at TEXT NOT NULL,
      shipped_at TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE order_items (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL
    )`,
    `CREATE TABLE shipments (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      courier TEXT NOT NULL,
      tracking_number TEXT NOT NULL,
      courier_status TEXT,
      status_normalized TEXT NOT NULL,
      delivery_fee_centimes INTEGER,
      return_fee_centimes INTEGER,
      label_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(store_id, order_id),
      UNIQUE(store_id, tracking_number)
    )`,
    `CREATE TABLE order_events (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE inventory_movements (
      id TEXT PRIMARY KEY NOT NULL,
      store_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(store_id, sku, reason, reference)
    )`,
  ]) {
    await env.DB.prepare(statement).run();
  }

  const timestamp = '2026-10-03T10:00:00.000Z';
  await env.DB.batch([
    env.DB.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?)').bind(
      'customer-1',
      'para-main',
      '+212612345678',
      'Salma Test',
      'Rabat',
    ),
    env.DB.prepare('INSERT INTO products VALUES (?, ?, ?, ?)').bind(
      'product-1',
      'para-main',
      'BIO-OIL-125ML',
      'Bio-Oil 125ml',
    ),
    env.DB.prepare(
      `INSERT INTO orders
          (id, store_id, order_number, customer_id, status, cod_amount_centimes, city, address,
           placed_at, shipped_at, updated_at)
         VALUES (?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      ORDER_ID,
      'para-main',
      'PARA-101',
      'customer-1',
      24_500,
      'Rabat',
      '12 rue Atlas',
      timestamp,
      timestamp,
    ),
    env.DB.prepare('INSERT INTO order_items VALUES (?, ?, ?, ?, ?)').bind(
      'item-1',
      'para-main',
      ORDER_ID,
      'BIO-OIL-125ML',
      2,
    ),
  ]);
});

describe('create parcel workflow', () => {
  it('shows the action only for a confirmed order', async () => {
    const client = successfulClient();
    const response = await requestWith(client, '/admin/orders');
    const body = await response.text();

    expect(body).toContain('Créer le colis');
    expect(body).toContain(`/admin/orders/${ORDER_ID}/parcel`);

    await env.DB.prepare("UPDATE orders SET status = 'PACKED' WHERE id = ?").bind(ORDER_ID).run();
    const packedBody = await (await requestWith(client, '/admin/orders')).text();
    expect(packedBody).not.toContain('Créer le colis');
  });

  it('creates one shipment and transitions the order to PACKED', async () => {
    const client = successfulClient();
    const response = await postParcel(client);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/orders?status=CONFIRMED');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(client.createParcelCalls).toEqual([
      {
        codAmountCentimes: 24_500,
        idempotencyKey: ORDER_ID,
        orderId: ORDER_ID,
        orderReference: 'PARA-101',
        productSummary: '2× Bio-Oil 125ml',
        receiver: {
          address: '12 rue Atlas',
          city: 'Rabat',
          name: 'Salma Test',
          phoneE164: '+212612345678',
        },
      },
    ]);

    const order = await env.DB.prepare('SELECT status, shipped_at FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ shipped_at: string | null; status: string }>();
    const shipment = await env.DB.prepare(
      `SELECT courier, tracking_number, delivery_fee_centimes, return_fee_centimes,
              label_url, status_normalized
       FROM shipments WHERE order_id = ?`,
    )
      .bind(ORDER_ID)
      .first<Record<string, unknown>>();
    const event = await env.DB.prepare(
      'SELECT from_status, to_status, actor, reason FROM order_events WHERE order_id = ?',
    )
      .bind(ORDER_ID)
      .first<Record<string, unknown>>();

    expect(order).toEqual({ shipped_at: null, status: 'PACKED' });
    expect(shipment).toEqual({
      courier: 'fake-courier',
      delivery_fee_centimes: 3_500,
      label_url: 'https://example.test/labels/TRACK-101.pdf',
      return_fee_centimes: 1_500,
      status_normalized: 'created',
      tracking_number: 'TRACK-101',
    });
    expect(event).toEqual({
      actor: 'user:admin@anfashpara.test',
      from_status: 'CONFIRMED',
      reason: 'parcel_created',
      to_status: 'PACKED',
    });
  });

  it('uses manual self-delivery by default without courier credentials', async () => {
    const response = await createApp(authenticatedAccess).request(
      `https://example.com/admin/orders/${ORDER_ID}/parcel`,
      { method: 'POST' },
      bindings(),
    );
    const shipment = await env.DB.prepare(
      'SELECT courier, tracking_number, status_normalized FROM shipments WHERE order_id = ?',
    )
      .bind(ORDER_ID)
      .first<Record<string, unknown>>();

    expect(response.status).toBe(303);
    expect(shipment).toEqual({
      courier: 'self-delivery',
      status_normalized: 'created',
      tracking_number: 'SELF-PARA-101-00000001',
    });
  });

  it('applies PACKED then SHIPPED when the courier reports pickup', async () => {
    const client = successfulClient({ ...createdParcel, rawStatus: 'PICKED', status: 'picked' });
    expect((await postParcel(client)).status).toBe(303);

    const order = await env.DB.prepare('SELECT status, shipped_at FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ shipped_at: string | null; status: string }>();
    const events = await env.DB.prepare(
      'SELECT from_status, to_status, actor FROM order_events WHERE order_id = ? ORDER BY rowid',
    )
      .bind(ORDER_ID)
      .all<Record<string, unknown>>();
    const movements = await env.DB.prepare(
      'SELECT sku, quantity, reason, reference FROM inventory_movements ORDER BY rowid',
    ).all<Record<string, unknown>>();

    expect(order?.status).toBe('SHIPPED');
    expect(order?.shipped_at).not.toBeNull();
    expect(events.results).toEqual([
      {
        actor: 'user:admin@anfashpara.test',
        from_status: 'CONFIRMED',
        to_status: 'PACKED',
      },
      { actor: 'courier:fake-courier', from_status: 'PACKED', to_status: 'SHIPPED' },
    ]);
    expect(movements.results).toEqual([
      {
        quantity: -2,
        reason: 'shipped',
        reference: `order:${ORDER_ID}:shipped`,
        sku: 'BIO-OIL-125ML',
      },
    ]);
  });

  it('rejects ineligible orders before calling the courier', async () => {
    await env.DB.prepare("UPDATE orders SET status = 'CONFIRMING' WHERE id = ?")
      .bind(ORDER_ID)
      .run();
    const client = successfulClient();
    const response = await postParcel(client);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'order_not_eligible',
        message: 'Seule une commande confirmée peut créer un colis.',
      },
    });
    expect(client.createParcelCalls).toHaveLength(0);
  });

  it('prevents a duplicate parcel before a second courier call', async () => {
    const client = successfulClient();
    expect((await postParcel(client)).status).toBe(303);
    const duplicate = await postParcel(client);

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'parcel_already_exists' } });
    expect(client.createParcelCalls).toHaveLength(1);
  });

  it('leaves a courier failure unchanged and retryable', async () => {
    const failure = new CourierClientError('create_parcel', 'planned_outage', 'Planned outage.', {
      retryable: true,
    });
    const failingClient = new FakeCourierClient({
      createParcel: courierFailure(failure),
      statuses: {},
    });
    const failedResponse = await postParcel(failingClient);

    expect(failedResponse.status).toBe(503);
    expect(await failedResponse.json()).toMatchObject({
      error: { code: 'courier_temporarily_unavailable' },
    });
    expect(await readOrderStatus()).toBe('CONFIRMED');
    expect(await countShipments()).toBe(0);
    expect(await rowCount('inventory_movements')).toBe(0);

    const retryClient = successfulClient();
    expect((await postParcel(retryClient)).status).toBe(303);
    expect(await readOrderStatus()).toBe('PACKED');
  });

  it('rolls back local writes when persistence fails after courier success', async () => {
    await env.DB.prepare('DROP TABLE order_events').run();
    const client = successfulClient();
    const response = await postParcel(client);

    expect(response.status).toBe(503);
    expect(await readOrderStatus()).toBe('CONFIRMED');
    expect(await countShipments()).toBe(0);
    expect(client.createParcelCalls[0]?.idempotencyKey).toBe(ORDER_ID);
  });
});

describe('courier Worker-secret adapter', () => {
  it('creates deterministic internal references in manual mode', async () => {
    const client = new ManualCourierClient();

    await expect(client.createParcel(parcelInput())).resolves.toEqual({
      courier: 'self-delivery',
      rawStatus: 'MANUAL_CREATED',
      status: 'created',
      trackingNumber: 'SELF-PARA-101-00000001',
    });
    await expect(client.createParcel(parcelInput())).resolves.toMatchObject({
      trackingNumber: 'SELF-PARA-101-00000001',
    });
  });

  it('requires operator updates instead of inventing manual tracking statuses', async () => {
    const client = new ManualCourierClient();

    await expect(client.getStatus('SELF-PARA-101-00000001')).rejects.toMatchObject({
      code: 'manual_status_required',
      operation: 'get_status',
      retryable: false,
    });
  });

  it('loads credentials from bindings and sends them only as request headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        deliveryFeeCentimes: 3_500,
        labelUrl: 'https://example.test/label.pdf',
        rawStatus: 'CREATED',
        status: 'created',
        trackingNumber: 'TRACK-101',
      }),
    );
    const client = new HttpCourierClient(
      {
        accountId: 'account-secret',
        apiToken: 'token-secret',
        apiUrl: 'https://courier.example.test/v1',
        courierName: 'configured-courier',
      },
      fetcher,
    );
    const result = await client.createParcel(parcelInput());

    expect(result).toMatchObject({ courier: 'configured-courier', trackingNumber: 'TRACK-101' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url.toString()).toBe('https://courier.example.test/v1/parcels');
    const headers = new Headers(request?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-secret');
    expect(headers.get('X-Courier-Account-Id')).toBe('account-secret');
    expect(headers.get('Idempotency-Key')).toBe(ORDER_ID);
    expect(String(request?.body)).not.toContain('token-secret');
  });

  it('requires secrets only when API mode is explicitly selected', () => {
    expect(
      createCourierClientFromBindings({ ...bindings(), COURIER_MODE: 'manual' }),
    ).toBeInstanceOf(ManualCourierClient);
    expect(() => createCourierClientFromBindings({ ...bindings(), COURIER_MODE: 'api' })).toThrow(
      CourierConfigurationError,
    );
  });
});

function successfulClient(result = createdParcel): FakeCourierClient {
  return new FakeCourierClient({ createParcel: courierSuccess(result), statuses: {} });
}

async function requestWith(client: FakeCourierClient, path: string): Promise<Response> {
  return createApp(authenticatedAccess, () => client).request(
    `https://example.com${path}`,
    undefined,
    bindings(),
  );
}

async function postParcel(client: FakeCourierClient): Promise<Response> {
  return createApp(authenticatedAccess, () => client).request(
    `https://example.com/admin/orders/${ORDER_ID}/parcel`,
    { method: 'POST' },
    bindings(),
  );
}

async function readOrderStatus(): Promise<string | undefined> {
  return (
    await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(ORDER_ID)
      .first<{ status: string }>()
  )?.status;
}

async function countShipments(): Promise<number> {
  return (
    (await env.DB.prepare('SELECT COUNT(*) AS count FROM shipments').first<{ count: number }>())
      ?.count ?? 0
  );
}

async function rowCount(table: string): Promise<number> {
  return (
    (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())
      ?.count ?? 0
  );
}

function parcelInput() {
  return {
    codAmountCentimes: 24_500,
    idempotencyKey: ORDER_ID,
    orderId: ORDER_ID,
    orderReference: 'PARA-101',
    productSummary: '2× Bio-Oil 125ml',
    receiver: {
      address: '12 rue Atlas',
      city: 'Rabat',
      name: 'Salma Test',
      phoneE164: '+212612345678',
    },
  } as const;
}
