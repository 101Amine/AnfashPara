// apps/api/test/stagingLifecycle.spec.ts
import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import type { AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';
import { resetOrderDatabase } from './helpers/orderDatabase';
import migration from '../migrations/0002_full_order_schema.sql?raw';
const run = 'abcdef0123456789abcdef0123456789';
const ts = '2026-10-03T12:00:00.000Z';
const uuid = (n: number) => `0199b001-1000-7000-8000-${String(n).padStart(12, '0')}`;
const origin = 'https://para-api-staging.alanfashpara.workers.dev';
const access: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  c.set('accessIdentity', {
    email: 'staging-runner@service.invalid',
    subject: 'test.access',
    kind: 'service',
  });
  await next();
};
const bindings = () => ({ ...env, ENVIRONMENT: 'staging' });
beforeEach(async () => {
  for (const name of [
    'inventory_movements',
    'confirmation_attempts',
    'shipment_events',
    'shipments',
  ])
    await env.DB.prepare(`DROP TABLE IF EXISTS ${name}`).run();
  await resetOrderDatabase(env.DB);
  for (const statement of migration.split('--> statement-breakpoint'))
    if (
      /CREATE TABLE `(?:inventory_movements|confirmation_attempts|shipment_events|shipments)`|CREATE (?:UNIQUE )?INDEX `(?:inventory_|confirmation_|shipments_|shipment_events_)/u.test(
        statement,
      )
    )
      await env.DB.prepare(statement).run();
  await env.DB.prepare(
    `INSERT INTO customers(id,store_id,phone_e164,orders_count,delivered_count,refused_count,blacklisted,created_at,updated_at)
    VALUES (?,'para-main','+212611111111',5,2,1,0,?,?)`,
  )
    .bind(uuid(100), ts, ts)
    .run();
  for (let n = 1; n <= 5; n++)
    await env.DB.prepare(
      `INSERT INTO orders(id,store_id,external_id,order_number,customer_id,status,cod_amount_centimes,shipping_fee_customer_centimes,
    address,note,utm_source,utm_campaign,placed_at,raw_payload_json,created_at,updated_at)
    VALUES (?,'para-main',?,?,?,'DELIVERED',100,0,'Adresse test staging - ne pas livrer','STAGING_LIFECYCLE','staging-test',?,?,'{}',?,?)`,
    )
      .bind(uuid(n), `stg-${n}`, `STG-${run}-${n}`, uuid(100), run, ts, ts, ts)
      .run();
  await env.DB.prepare(
    `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
    VALUES (?,'para-main','BIO-OIL-125ML',-1,'shipped',?,?)`,
  )
    .bind(uuid(200), `order:${uuid(1)}:shipped`, ts)
    .run();
  await env.DB.prepare(
    `INSERT INTO outbox(id,store_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,created_at,updated_at)
    VALUES (?,'para-main','order.confirmed','order',?,'{}','pending',0,?,?)`,
  )
    .bind(uuid(201), uuid(1), ts, ts)
    .run();
});
const archive = () =>
  createApp(access).request(
    origin + '/admin/testing/lifecycle',
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run, action: 'archive' }),
    },
    bindings(),
  );
it('reports synthetic counts without phone, address or name', async () => {
  const response = await createApp(access).request(
    origin + '/admin/testing/lifecycle?run=' + run,
    {},
    bindings(),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text).orders).toHaveLength(5);
  expect(text).not.toContain('+212');
  expect(text).not.toContain('Adresse');
  expect(text).toContain('customerDelivered');
});
it('archives idempotently, restores stock and stops pending synthetic outbox sends', async () => {
  expect((await archive()).status).toBe(200);
  expect((await archive()).status).toBe(200);
  expect(
    (
      await env.DB.prepare('SELECT SUM(quantity) AS n FROM inventory_movements').first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
  expect(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first<{ n: number }>())
      ?.n,
  ).toBe(2);
  expect(
    (await env.DB.prepare('SELECT status FROM outbox').first<{ status: string }>())?.status,
  ).toBe('failed');
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE note='STAGING_LIFECYCLE_ARCHIVED'",
      ).first<{ n: number }>()
    )?.n,
  ).toBe(5);
});
it('refuses incomplete runs without archiving any evidence', async () => {
  await env.DB.prepare('DELETE FROM orders WHERE id=?').bind(uuid(5)).run();
  expect((await archive()).status).toBe(409);
  expect(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first<{ n: number }>())
      ?.n,
  ).toBe(1);
});
it('rolls back the entire archive if a later statement fails', async () => {
  await env.DB.prepare('DROP TABLE outbox').run();
  expect((await archive()).status).toBe(503);
  expect(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first<{ n: number }>())
      ?.n,
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE note='STAGING_LIFECYCLE_ARCHIVED'",
      ).first<{ n: number }>()
    )?.n,
  ).toBe(0);
});
it('does not expose staging testing routes on production and rejects bad origin/run', async () => {
  const app = createApp(access);
  expect(
    (await app.request(origin + '/admin/testing/lifecycle', {}, { ...env, ENVIRONMENT: 'prod' }))
      .status,
  ).toBe(404);
  expect(
    (await app.request(origin + '/admin/testing/lifecycle?run=invalid', {}, bindings())).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        origin + '/admin/testing/lifecycle',
        { method: 'POST', body: JSON.stringify({ run, action: 'archive' }) },
        bindings(),
      )
    ).status,
  ).toBe(403);
});
