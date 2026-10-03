// apps/api/test/publicOrders.spec.ts
import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppBindings } from '../src/auth/cloudflareAccess';
import worker from '../src/index';
import { resetOrderDatabase, rowCount } from './helpers/orderDatabase';

const payload = {
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
  items: [
    { quantity: 2, sku: 'BIO-OIL-125ML' },
    { quantity: 1, sku: 'MUSTELA-250ML' },
  ],
} as const;

let ipSequence = 0;

beforeEach(async () => {
  if (!env.DB) throw new Error('The test D1 binding is missing');
  await resetOrderDatabase(env.DB);
  ipSequence += 1;
});

describe('POST /api/orders', () => {
  it('requires a valid idempotency key', async () => {
    const response = await postOrder(payload, undefined);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_idempotency_key',
        message: 'Idempotency-Key must contain 8 to 128 safe characters',
      },
    });
  });

  it('requires JSON and rejects bodies larger than 16 KiB', async () => {
    const unsupported = await postRaw('plain text', 'checkout-media-001', 'text/plain');
    expect(unsupported.status).toBe(415);

    const oversized = await postRaw(
      JSON.stringify({ ...payload, padding: 'x'.repeat(17 * 1024) }),
      'checkout-large-001',
      'application/json',
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: { code: 'payload_too_large', message: 'Order payload exceeds 16 KiB' },
    });
  });

  it('rejects client-owned price, total and status fields', async () => {
    const response = await postOrder(
      { ...payload, codAmountCentimes: 1, status: 'SETTLED' },
      'checkout-strict-001',
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_payload', message: 'Invalid order payload' },
    });
    await expect(rowCount(env.DB, 'orders')).resolves.toBe(0);
  });

  it('creates and prices an order from authoritative D1 products', async () => {
    const response = await postOrder(payload, 'checkout-success-001');

    expect(response.status).toBe(201);
    const body = await response.json<{
      codAmountCentimes: number;
      currency: string;
      duplicate: boolean;
      orderId: string;
      orderNumber: string;
      status: string;
    }>();
    expect(body).toMatchObject({
      codAmountCentimes: 28_700,
      currency: 'MAD',
      duplicate: false,
      status: 'CONFIRMING',
    });
    expect(body.orderNumber).toMatch(/^PARA-[A-F0-9]{16}$/u);

    const order = await env.DB.prepare(
      `SELECT status, cod_amount_centimes, shipping_fee_customer_centimes
       FROM orders WHERE id = ?`,
    )
      .bind(body.orderId)
      .first();
    expect(order).toEqual({
      cod_amount_centimes: 28_700,
      shipping_fee_customer_centimes: 0,
      status: 'CONFIRMING',
    });

    const items = await env.DB.prepare(
      `SELECT sku, unit_price_centimes, unit_cogs_centimes
       FROM order_items ORDER BY sku`,
    ).all();
    expect(items.results).toEqual([
      { sku: 'BIO-OIL-125ML', unit_cogs_centimes: 4200, unit_price_centimes: 8900 },
      { sku: 'MUSTELA-250ML', unit_cogs_centimes: 5100, unit_price_centimes: 10900 },
    ]);
    await expect(rowCount(env.DB, 'order_events')).resolves.toBe(1);
    await expect(rowCount(env.DB, 'outbox')).resolves.toBe(1);
  });

  it('returns the original result when the same key and payload are replayed', async () => {
    const first = await postOrder(payload, 'checkout-replay-001');
    const firstBody = await first.json<Record<string, unknown>>();
    const replay = await postOrder(payload, 'checkout-replay-001');

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ...firstBody, duplicate: true });
    await expect(rowCount(env.DB, 'orders')).resolves.toBe(1);
    await expect(rowCount(env.DB, 'order_items')).resolves.toBe(2);
  });

  it('returns a controlled conflict when a key is reused for another request', async () => {
    expect((await postOrder(payload, 'checkout-conflict-001')).status).toBe(201);
    const response = await postOrder(
      { ...payload, customer: { ...payload.customer, city: 'Casablanca' } },
      'checkout-conflict-001',
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'idempotency_conflict',
        message: 'Idempotency key was already used with a different request',
      },
    });
    await expect(rowCount(env.DB, 'orders')).resolves.toBe(1);
  });

  it('commits only one order for concurrent duplicate requests', async () => {
    const [left, right] = await Promise.all([
      postOrder(payload, 'checkout-concurrent-001'),
      postOrder(payload, 'checkout-concurrent-001'),
    ]);
    const statuses = [left.status, right.status].sort();

    expect(statuses).toEqual([200, 201]);
    const bodies = await Promise.all([left.json(), right.json()]);
    expect(new Set(bodies.map((body) => (body as { orderId: string }).orderId)).size).toBe(1);
    await expect(rowCount(env.DB, 'orders')).resolves.toBe(1);
    await expect(rowCount(env.DB, 'order_events')).resolves.toBe(1);
  });

  it('rejects invalid phones and unknown SKUs without partial writes', async () => {
    const invalidPhone = await postOrder(
      { ...payload, customer: { ...payload.customer, phone: '123' } },
      'checkout-phone-001',
    );
    expect(invalidPhone.status).toBe(422);

    const unknownSku = await postOrder(
      { ...payload, items: [{ quantity: 1, sku: 'DOES-NOT-EXIST' }] },
      'checkout-sku-001',
    );
    expect(unknownSku.status).toBe(422);
    await expect(rowCount(env.DB, 'orders')).resolves.toBe(0);
    await expect(rowCount(env.DB, 'webhook_inbox')).resolves.toBe(0);
  });
});

async function postOrder(body: unknown, idempotencyKey: string | undefined): Promise<Response> {
  return postRaw(JSON.stringify(body), idempotencyKey, 'application/json');
}

async function postRaw(
  body: string,
  idempotencyKey: string | undefined,
  contentType: string,
): Promise<Response> {
  const context = createExecutionContext();
  const bindings: AppBindings = { ...env };
  const headers = new Headers({
    'CF-Connecting-IP': `198.51.100.${ipSequence}`,
    'Content-Type': contentType,
  });
  if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);

  return worker.fetch(
    new Request('https://example.com/api/orders', {
      body,
      headers,
      method: 'POST',
    }),
    bindings,
    context,
  );
}
