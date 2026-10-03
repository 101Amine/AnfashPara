// apps/api/test/inventoryOperations.spec.ts
import { env } from 'cloudflare:test';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import migration from '../migrations/0002_full_order_schema.sql?raw';
import auditMigration from '../migrations/0007_long_night_nurse.sql?raw';
import type { AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';
import { resetOrderDatabase } from './helpers/orderDatabase';
import { getStockBySku } from '../src/modules/inventory/inventory.service';
import {
  recordInventoryOperation,
  readInventoryOperations,
} from '../src/modules/inventory/inventoryOperations.service';
import { encodeInventoryCursor } from '../src/modules/inventory/inventoryOperations.schema';

const sku = 'BIO-OIL-125ML';
const ts = '2026-10-03T12:00:00.000Z';
const uuid = (n: number) => `0199b001-1000-7000-8000-${String(n).padStart(12, '0')}`;
const actor = 'user:admin@example.test';
const operation = (reference = 'purchase-1') => ({
  sku,
  quantity: 10,
  reason: 'purchase' as const,
  reference,
  note: 'Facture fictive, lot inspecté',
});
const access: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  c.set('accessIdentity', { email: 'admin@example.test', subject: 'test' });
  await next();
};
async function post(body: unknown, changes: Record<string, string> = {}, raw?: string) {
  return createApp(access).request(
    'https://example.test/admin/inventory/movements',
    {
      method: 'POST',
      headers: {
        Origin: 'https://example.test',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...changes,
      },
      body: raw ?? JSON.stringify(body),
    },
    env,
  );
}
beforeEach(async () => {
  await env.DB.prepare('DROP TABLE IF EXISTS inventory_movements').run();
  await resetOrderDatabase(env.DB);
  for (const statement of migration.split('--> statement-breakpoint'))
    if (/CREATE TABLE `inventory_movements`|CREATE (?:UNIQUE )?INDEX `inventory_/u.test(statement))
      await env.DB.prepare(statement).run();
  // A legacy automatic movement must survive migration unchanged.
  await env.DB.prepare(
    `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
    VALUES (?,'para-main',?,2,'returned','order:legacy:returned',?)`,
  )
    .bind(uuid(1), sku, ts)
    .run();
  for (const statement of auditMigration.split('--> statement-breakpoint').filter((s) => s.trim()))
    await env.DB.prepare(statement).run();
});
describe('append-only inventory operations', () => {
  it('isolates store-owned SKUs and movements', async () => {
    await env.DB.prepare(
      `INSERT INTO products(id,store_id,sku,slug,name,price_centimes,cogs_centimes,active,created_at,updated_at)
      VALUES ('foreign','other','FOREIGN','foreign','Foreign',100,50,1,?,?)`,
    )
      .bind(ts, ts)
      .run();
    await expect(
      recordInventoryOperation(env.DB, { ...operation(), sku: 'FOREIGN' }, actor),
    ).rejects.toMatchObject({ code: 'sku_not_found' });
    await env.DB.prepare(
      `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
      VALUES (?,'other',?,100,'purchase','foreign',?)`,
    )
      .bind(uuid(900), sku, ts)
      .run();
    expect((await readInventoryOperations(env.DB, sku)).stock[0]?.quantity).toBe(2);
    expect((await readInventoryOperations(env.DB, sku)).history).toHaveLength(1);
  });
  it('preserves original audit fields on a replay by another admin', async () => {
    const first = await recordInventoryOperation(env.DB, operation(), actor, new Date(ts));
    await recordInventoryOperation(
      env.DB,
      operation(),
      'user:second@example.test',
      new Date('2026-10-04T12:00:00.000Z'),
    );
    const row = (await readInventoryOperations(env.DB, sku)).history.find((r) => r.id === first.id);
    expect(row).toMatchObject({ actor, created_at: ts });
  });
  it('preserves automatic movements and applies purchase, damage, expiry and signed count differences', async () => {
    await recordInventoryOperation(env.DB, operation(), actor);
    await recordInventoryOperation(
      env.DB,
      { ...operation('damage'), quantity: -2, reason: 'damaged' },
      actor,
    );
    await recordInventoryOperation(
      env.DB,
      { ...operation('expiry'), quantity: -1, reason: 'expired' },
      actor,
    );
    await recordInventoryOperation(
      env.DB,
      { ...operation('count'), quantity: 3, reason: 'adjustment' },
      actor,
    );
    await recordInventoryOperation(
      env.DB,
      { ...operation('count-down'), quantity: -1, reason: 'adjustment' },
      actor,
    );
    expect(await getStockBySku(env.DB, sku)).toBe(11);
    const data = await readInventoryOperations(env.DB, sku);
    expect(data.history).toHaveLength(6);
    expect(data.history.find((r) => r.reason === 'expired')).toMatchObject({
      quantity: -1,
      actor,
      note: operation().note,
    });
    expect(data.history.find((r) => r.id === uuid(1))).toMatchObject({
      reason: 'returned',
      actor: null,
      note: null,
      quantity: 2,
    });
    expect(data.stock[0]?.quantity).toBe(11);
  });
  it('deduplicates concurrent writes and preserves the first actor', async () => {
    const results = await Promise.all([
      recordInventoryOperation(env.DB, operation(), actor),
      recordInventoryOperation(env.DB, operation(), 'user:other@example.test'),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(await getStockBySku(env.DB, sku)).toBe(12);
    const row = await env.DB.prepare('SELECT actor FROM inventory_movements WHERE reference=?')
      .bind('admin:purchase-1')
      .first<{ actor: string }>();
    expect([actor, 'user:other@example.test']).toContain(row?.actor);
  });
  it('rejects conflicting references across SKU, reason, quantity and note', async () => {
    await recordInventoryOperation(env.DB, operation(), actor);
    for (const change of [
      { sku: 'MUSTELA-250ML' },
      { quantity: 11 },
      { reason: 'adjustment' as const },
      { note: 'Different' },
    ])
      await expect(
        recordInventoryOperation(env.DB, { ...operation(), ...change }, actor),
      ).rejects.toMatchObject({ code: 'reference_conflict' });
    expect(await getStockBySku(env.DB, sku)).toBe(12);
  });
  it('rejects invalid actors, nonexistent SKUs, zero, fractional and mismatched quantities', async () => {
    await expect(recordInventoryOperation(env.DB, operation(), 'webhook')).rejects.toMatchObject({
      code: 'invalid_actor',
    });
    await expect(
      recordInventoryOperation(env.DB, { ...operation(), sku: 'unknown' }, actor),
    ).rejects.toMatchObject({ code: 'sku_not_found' });
    for (const change of [
      { quantity: 0 },
      { quantity: 1.1 },
      { quantity: -1 },
      { reason: 'damaged' as const },
      { reason: 'expired' as const },
      { note: '' },
      { quantity: 100001 },
    ])
      await expect(
        recordInventoryOperation(env.DB, { ...operation(), ...change }, actor),
      ).rejects.toMatchObject({ code: 'invalid_operation' });
    expect(await getStockBySku(env.DB, sku)).toBe(2);
  });
  it('uses stable cursor pagination for tied timestamps', async () => {
    for (let n = 0; n < 25; n++)
      await recordInventoryOperation(env.DB, operation(`p-${n}`), actor, new Date(ts));
    const first = await readInventoryOperations(env.DB, sku);
    expect(first.history).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const cursor = JSON.parse(atob(first.nextCursor!)) as {
      id: string;
      createdAt: string;
      sku: string;
    };
    const second = await readInventoryOperations(env.DB, sku, cursor);
    expect(second.history).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.history, ...second.history].map((r) => r.id)).size).toBe(26);
    expect(first.stock[0]?.quantity).toBe(252);
  });
  it('allows negative balances and inactive product inspection without overwriting stock', async () => {
    await env.DB.prepare('UPDATE products SET active=0 WHERE sku=?').bind(sku).run();
    await recordInventoryOperation(
      env.DB,
      { ...operation('loss'), quantity: -5, reason: 'damaged' },
      actor,
    );
    expect((await readInventoryOperations(env.DB, sku)).stock[0]?.quantity).toBe(-3);
  });
});
describe('protected inventory HTTP operations', () => {
  it('preserves the stable reference and draft after a database failure', async () => {
    await env.DB.prepare('DROP TABLE inventory_movements').run();
    const failed = await post(operation(), { Accept: 'text/html' });
    expect(failed.status).toBe(503);
    const output = await failed.text();
    expect(output).toContain('value="purchase-1"');
    expect(output).toContain('value="10"');
    expect(output).toContain(operation().note);
  });
  it('enforces real Access middleware on both GET and POST', async () => {
    const app = createApp();
    for (const method of ['GET', 'POST'])
      expect(
        (
          await app.request(
            `https://example.test/admin/inventory${method === 'POST' ? '/movements' : ''}`,
            { method },
            env,
          )
        ).status,
      ).not.toBe(200);
    expect(await getStockBySku(env.DB, sku)).toBe(2);
  });
  it('returns 201 then 200 duplicate and 409 conflict with private responses', async () => {
    const first = await post(operation());
    expect(first.status).toBe(201);
    expect(first.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect((await post(operation())).status).toBe(200);
    expect((await post({ ...operation(), quantity: 11 })).status).toBe(409);
    const data = await (
      await createApp(access).request(
        'https://example.test/admin/inventory?sku=' + sku,
        { headers: { Accept: 'application/json' } },
        env,
      )
    ).json<{ history: { actor: string }[] }>();
    expect(data.history.some((r) => r.actor === actor)).toBe(true);
  });
  it('rejects cross-origin, missing Origin and cross-site writes', async () => {
    for (const headers of [
      { Origin: 'https://evil.test' },
      { Origin: '' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ])
      expect((await post(operation(), headers)).status).toBe(403);
    expect(await getStockBySku(env.DB, sku)).toBe(2);
  });
  it('rejects malformed and oversized bodies, bad types and actor injection', async () => {
    expect((await post(null, {}, '{')).status).toBe(400);
    expect((await post(operation(), {}, 'x'.repeat(8193))).status).toBe(413);
    expect((await post(operation(), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post({ ...operation(), actor: 'user:forged@example.test' })).status).toBe(400);
    expect((await post({ ...operation(), sku: 'missing' })).status).toBe(404);
  });
  it('accepts French form submissions, rejects repeated fields and escapes notes', async () => {
    const form = new URLSearchParams({
      ...operation(),
      quantity: '10',
      note: '<script>secret</script>',
    });
    const response = await post(
      null,
      { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      form.toString(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('saved=yes');
    const page = await createApp(access).request(
      'https://example.test/admin/inventory?sku=' + sku,
      {},
      env,
    );
    const output = await page.text();
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('width=device-width');
    expect(output).toContain('Inspectez chaque retour');
    expect(
      (
        await post(
          null,
          { 'Content-Type': 'application/x-www-form-urlencoded' },
          form.toString() + '&quantity=10',
        )
      ).status,
    ).toBe(400);
  });
  it('validates cursors, unknown SKUs and sanitizes database failures', async () => {
    const app = createApp(access);
    expect(
      (await app.request('https://example.test/admin/inventory?cursor=invalid&sku=' + sku, {}, env))
        .status,
    ).toBe(400);
    const cursor = encodeInventoryCursor({ id: uuid(1), createdAt: ts, sku: 'OTHER' });
    expect(
      (
        await app.request(
          'https://example.test/admin/inventory?' + new URLSearchParams({ sku, cursor }),
          {},
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request('https://example.test/admin/inventory?sku=unknown', {}, env)).status,
    ).toBe(404);
    await env.DB.prepare('DROP TABLE inventory_movements').run();
    const bad = await post(operation());
    expect(bad.status).toBe(503);
    expect(await bad.text()).not.toContain('SQLITE');
    expect(bad.headers.get('Cache-Control')).toContain('no-store');
  });
});
