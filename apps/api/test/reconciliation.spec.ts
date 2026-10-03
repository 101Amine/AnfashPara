// apps/api/test/reconciliation.spec.ts
import { env } from 'cloudflare:test';
import { SETTLEMENT_COLUMNS, transition } from '@para/core';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import migration0 from '../migrations/0000_lethal_jamie_braddock.sql?raw';
import migration1 from '../migrations/0001_faithful_medusa.sql?raw';
import migration2 from '../migrations/0002_full_order_schema.sql?raw';
import migration3 from '../migrations/0003_sparkling_iron_fist.sql?raw';
import migration4 from '../migrations/0004_rainy_loki.sql?raw';
import migration5 from '../migrations/0005_even_lilith.sql?raw';
import type { AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';
import {
  importReconciliation,
  previewReconciliation,
} from '../src/modules/settlements/reconciliation.service';

const origin = 'https://example.com';
const access: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  c.set('accessIdentity', { email: 'admin@example.test', subject: 'test' });
  await next();
};
const uuid = (n: number) => `0199b001-1000-7000-8000-${String(n).padStart(12, '0')}`;
const input = (rows = 'T1,250,30,0,220,delivered') => ({
  courier: 'manual',
  statementReference: 'DEMO-01',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-03',
  amountPaid: '220.00',
  source: `${SETTLEMENT_COLUMNS.join(',')}\n${rows}`,
});
async function request(path: string, body: unknown, json = true) {
  return createApp(access).request(
    `${origin}/admin/settlements/${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: json ? 'application/json' : 'text/html',
        Origin: origin,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}
async function count(table: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}
async function status() {
  return (await env.DB.prepare('SELECT status FROM orders WHERE id=?')
    .bind(uuid(2))
    .first<{ status: string }>())!.status;
}
async function approve(value = input()) {
  const response = await request('reconcile', value);
  expect(response.status).toBe(200);
  return await response.json<{ approval: string; report: { exactCount: number } }>();
}

beforeEach(async () => {
  // Use actual migration SQL, including CHECKs/FKs and NOT NULL transaction assertions.
  for (const name of [
    'settlement_lines',
    'courier_settlements',
    'shipment_events',
    'shipments',
    'inventory_movements',
    'confirmation_attempts',
    'order_events',
    'order_items',
    'outbox',
    'orders',
    'customers',
    'products',
    'settings',
    'webhook_inbox',
    'ad_spend_daily',
  ])
    await env.DB.prepare(`DROP TABLE IF EXISTS ${name}`).run();
  for (const migration of [
    migration0,
    migration1,
    migration2,
    migration3,
    migration4,
    migration5,
  ]) {
    for (const statement of migration.split('--> statement-breakpoint').filter((s) => s.trim()))
      await env.DB.prepare(statement).run();
  }
  const timestamp = '2026-10-03T00:00:00.000Z';
  await env.DB.prepare(
    `INSERT INTO customers(id,store_id,phone_e164,created_at,updated_at) VALUES (?,'para-main','+212612345678',?,?)`,
  )
    .bind(uuid(1), timestamp, timestamp)
    .run();
  for (let n = 0; n < 2; n++) {
    await env.DB.prepare(
      `INSERT INTO orders(id,store_id,external_id,customer_id,status,cod_amount_centimes,placed_at,raw_payload_json,created_at,updated_at)
      VALUES (?,'para-main',?,?,'DELIVERED',25000,?,'{}',?,?)`,
    )
      .bind(uuid(2 + n), `external-${n}`, uuid(1), timestamp, timestamp, timestamp)
      .run();
    await env.DB.prepare(
      `INSERT INTO shipments(id,store_id,order_id,courier,tracking_number,status_normalized,delivery_fee_centimes,return_fee_centimes,created_at,updated_at)
      VALUES (?,'para-main',?,'manual',?,'delivered',3000,1500,?,?)`,
    )
      .bind(uuid(4 + n), uuid(2 + n), `T${n + 1}`, timestamp, timestamp)
      .run();
  }
});

describe('settlement reconciliation and import', () => {
  it('rolls back two eligible orders when the final audit event fails', async () => {
    const value = {
      ...input('T1,250,30,0,220,delivered\nT2,250,30,0,220,delivered'),
      amountPaid: '440',
    };
    const preview = await approve(value);
    await env.DB.prepare(
      `CREATE TRIGGER reject_second BEFORE INSERT ON order_events WHEN NEW.order_id='${uuid(3)}' BEGIN SELECT RAISE(ABORT,'second audit failure'); END`,
    ).run();
    expect(
      (await request('import', { ...value, approval: preview.approval, confirmed: true })).status,
    ).toBe(503);
    expect(await count('courier_settlements')).toBe(0);
    expect(await count('settlement_lines')).toBe(0);
    expect(await count('order_events')).toBe(0);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='DELIVERED'").first<{
        n: number;
      }>())!.n,
    ).toBe(2);
  });
  it('does not settle a delivered statement line for a still-shipped order', async () => {
    await env.DB.prepare("UPDATE orders SET status='SHIPPED'").run();
    const preview = await approve();
    expect(preview.report.exactCount).toBe(0);
    await request('import', { ...input(), approval: preview.approval, confirmed: true });
    expect(await status()).toBe('SHIPPED');
    expect(await count('order_events')).toBe(0);
  });
  it('escapes malicious tracking strings in the preview and preserves them in the approval form', async () => {
    const response = await request(
      'reconcile',
      input('</textarea><script>alert(1)</script>,250,30,0,220,delivered'),
      false,
    );
    const body = await response.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
  it('rejects oversize bodies before parsing and returns controlled unavailable/not-found errors', async () => {
    const response = await createApp(access).request(
      `${origin}/admin/settlements/reconcile`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2000000' },
        body: '{}',
      },
      env,
    );
    expect(response.status).toBe(413);
    expect(
      (
        await createApp(access).request(
          `${origin}/admin/settlements/reports/${uuid(99)}`,
          undefined,
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await createApp(access).request(
          `${origin}/admin/settlements/import`,
          { method: 'POST' },
          {},
        )
      ).status,
    ).toBe(503);
  });
  it('does not import an old seeded statement under its existing reference', async () => {
    const value = input();
    const preview = await approve(value);
    await env.DB.prepare(
      `INSERT INTO courier_settlements(id,store_id,courier,statement_reference,period_start,period_end,amount_paid_centimes,imported_at) VALUES (?,'para-main','manual','DEMO-01','2026-10-01','2026-10-03',22000,'2026-10-03T00:00:00.000Z')`,
    )
      .bind(uuid(20))
      .run();
    expect(
      (await request('import', { ...value, approval: preview.approval, confirmed: true })).status,
    ).toBe(409);
    expect(await status()).toBe('DELIVERED');
    expect(await count('order_events')).toBe(0);
  });
  it('shows the legacy seeded wrong-fee exception and preserves lines through migration 0005', async () => {
    for (const column of ['content_hash', 'report_json', 'imported_by'])
      await env.DB.prepare(`ALTER TABLE courier_settlements DROP COLUMN ${column}`).run();
    await env.DB.prepare(
      `INSERT INTO courier_settlements(id,store_id,courier,statement_reference,period_start,period_end,amount_paid_centimes,imported_at)
      VALUES (?,'para-main','sendit','SEED-STATEMENT-001','2026-09-01','2026-09-12',20800,'2026-10-03T00:00:00.000Z')`,
    )
      .bind(uuid(20))
      .run();
    await env.DB.prepare(
      `INSERT INTO settlement_lines(id,store_id,settlement_id,tracking_number,cod_collected_centimes,fee_centimes,net_centimes,expected_fee_centimes,line_status,shipment_id,created_at)
      VALUES (?,'para-main',?,'T2',25000,4200,20800,3500,'fee_mismatch',?,'2026-10-03T00:00:00.000Z')`,
    )
      .bind(uuid(21), uuid(20), uuid(5))
      .run();
    for (const statement of migration5.split('--> statement-breakpoint'))
      await env.DB.prepare(statement).run();
    expect(await count('settlement_lines')).toBe(1);
    const page = await createApp(access).request(
      `${origin}/admin/settlements/reports/${uuid(20)}`,
      undefined,
      env,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Exception : frais incorrects');
    expect(await status()).toBe('DELIVERED');
    const list = await createApp(access).request(
      `${origin}/admin/settlements/reports`,
      undefined,
      env,
    );
    expect(await list.text()).toContain('SEED-STATEMENT-001');
  });
  it('previews without writes, then settles atomically with an audited report', async () => {
    const preview = await approve();
    expect(preview.report.exactCount).toBe(1);
    expect(await count('courier_settlements')).toBe(0);
    expect(await status()).toBe('DELIVERED');
    const response = await request('import', {
      ...input(),
      approval: preview.approval,
      confirmed: true,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(await status()).toBe('SETTLED');
    expect(await count('settlement_lines')).toBe(1);
    const event = await env.DB.prepare(
      'SELECT actor,from_status,to_status,payload_json FROM order_events',
    ).first<{ payload_json: string }>();
    expect(event).toMatchObject({
      actor: 'reconciliation',
      from_status: 'DELIVERED',
      to_status: 'SETTLED',
    });
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      approvedBy: 'admin@example.test',
      netCentimes: 22000,
    });
    const result = await response.json<{ settlementId: string }>();
    const report = await createApp(access).request(
      `${origin}/admin/settlements/reports/${result.settlementId}`,
      { headers: { Accept: 'application/json' } },
      env,
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({ report: { exactCount: 1 } });
  });
  it('reimport returns the saved report and creates no second event', async () => {
    const preview = await approve();
    const body = { ...input(), approval: preview.approval, confirmed: true };
    expect((await request('import', body)).status).toBe(201);
    const again = await request('import', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true, report: { exactCount: 1 } });
    expect(await count('courier_settlements')).toBe(1);
    expect(await count('order_events')).toBe(1);
  });
  it('rejects a changed statement under the same identity', async () => {
    const preview = await approve();
    await request('import', { ...input(), approval: preview.approval, confirmed: true });
    expect(
      (
        await request('import', {
          ...input('T1,250,31,0,219,delivered'),
          approval: preview.approval,
          confirmed: true,
        })
      ).status,
    ).toBe(409);
    expect(await count('order_events')).toBe(1);
  });
  it('records wrong-fee and missing-tracking exceptions without settling them', async () => {
    const value = {
      ...input('T1,250,37,0,213,delivered\nUNKNOWN,250,30,0,220,delivered'),
      amountPaid: '433',
    };
    const preview = await approve(value);
    const response = await request('import', {
      ...value,
      approval: preview.approval,
      confirmed: true,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      report: {
        exactCount: 0,
        lines: [
          { classification: 'variance_over_100', varianceCentimes: -700 },
          { classification: 'unmatched' },
        ],
      },
    });
    expect(await status()).toBe('DELIVERED');
    expect(await count('order_events')).toBe(0);
  });
  it('marks every repeated tracking number duplicate', async () => {
    const value = {
      ...input('T1,250,30,0,220,delivered\nT1,250,30,0,220,delivered'),
      amountPaid: '440',
    };
    const preview = await approve(value);
    expect(
      (await request('import', { ...value, approval: preview.approval, confirmed: true })).status,
    ).toBe(201);
    expect(await count('settlement_lines')).toBe(2);
    expect(await count('order_events')).toBe(0);
  });
  it('does not settle an already matched shipment under a new reference', async () => {
    const preview = await approve();
    await request('import', { ...input(), approval: preview.approval, confirmed: true });
    const value = { ...input(), statementReference: 'DEMO-02' };
    const next = await approve(value);
    expect(next.report.exactCount).toBe(0);
    await request('import', { ...value, approval: next.approval, confirmed: true });
    expect(await count('order_events')).toBe(1);
  });
  it('rejects a stale preview after fees change', async () => {
    const preview = await approve();
    await env.DB.prepare('UPDATE shipments SET delivery_fee_centimes=3100 WHERE tracking_number=?')
      .bind('T1')
      .run();
    expect(
      (await request('import', { ...input(), approval: preview.approval, confirmed: true })).status,
    ).toBe(409);
    expect(await count('courier_settlements')).toBe(0);
    expect(await status()).toBe('DELIVERED');
  });
  it('aborts all statement/line/order writes when event insertion fails', async () => {
    await env.DB.prepare(
      "CREATE TRIGGER reject_settlement_event BEFORE INSERT ON order_events WHEN NEW.to_status='SETTLED' BEGIN SELECT RAISE(ABORT,'test failure'); END",
    ).run();
    const preview = await approve();
    expect(
      (await request('import', { ...input(), approval: preview.approval, confirmed: true })).status,
    ).toBe(503);
    expect(await count('courier_settlements')).toBe(0);
    expect(await count('settlement_lines')).toBe(0);
    expect(await status()).toBe('DELIVERED');
  });
  it('guards a concurrent mutation inside the write batch', async () => {
    // Trigger changes the fee after reload but before line insertion, inside the same transaction.
    await env.DB.prepare(
      "CREATE TRIGGER change_fee AFTER INSERT ON courier_settlements BEGIN UPDATE shipments SET delivery_fee_centimes=3100 WHERE tracking_number='T1'; END",
    ).run();
    const preview = await approve();
    expect(
      (await request('import', { ...input(), approval: preview.approval, confirmed: true })).status,
    ).toBe(409);
    expect(await count('courier_settlements')).toBe(0);
    expect(await status()).toBe('DELIVERED');
    expect(
      await env.DB.prepare(
        "SELECT delivery_fee_centimes FROM shipments WHERE tracking_number='T1'",
      ).first(),
    ).toEqual({ delivery_fee_centimes: 3000 });
  });
  it('deduplicates racing imports with a database uniqueness constraint', async () => {
    const value = input();
    const { approval } = await previewReconciliation(env.DB, value);
    const results = await Promise.all([
      importReconciliation(env.DB, value, approval, 'admin@example.test'),
      importReconciliation(env.DB, value, approval, 'admin@example.test'),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await count('order_events')).toBe(1);
  });
  it('requires explicit approval and a matching recorded receipt amount', async () => {
    expect((await request('import', input())).status).toBe(422);
    const value = { ...input(), amountPaid: '219.99' };
    const preview = await approve(value);
    expect(
      (await request('import', { ...value, approval: preview.approval, confirmed: true })).status,
    ).toBe(409);
    expect(await count('courier_settlements')).toBe(0);
  });
  it('matches by courier and store, not tracking alone', async () => {
    const preview = await request('reconcile', { ...input(), courier: 'different' });
    expect(await preview.json()).toMatchObject({
      report: { exactCount: 0, lines: [{ classification: 'unmatched' }] },
    });
    await env.DB.prepare("UPDATE shipments SET store_id='another-store'").run();
    expect((await approve()).report.exactCount).toBe(0);
  });
  it('rejects malformed input, actor injection, invalid dates and CSV rows', async () => {
    for (const body of [
      null,
      [],
      { ...input(), actor: 'reconciliation' },
      { ...input(), periodStart: '2026-02-30' },
      { ...input(), periodEnd: '2026-09-30' },
      input('T1,bad,30,0,220,delivered'),
    ])
      expect((await request('reconcile', body)).status).toBeGreaterThanOrEqual(400);
    expect(await count('courier_settlements')).toBe(0);
  });
  it('rejects foreign origins and unauthenticated imports/reports', async () => {
    expect(
      (
        await createApp(access).request(
          `${origin}/admin/settlements/import`,
          { method: 'POST', headers: { Origin: 'https://evil.test' } },
          env,
        )
      ).status,
    ).toBe(403);
    for (const path of ['reconcile', 'import', 'reports/fake'])
      expect(
        (
          await createApp().request(`${origin}/admin/settlements/${path}`, undefined, {
            ...env,
            CF_ACCESS_AUD: 'test',
            CF_ACCESS_TEAM_DOMAIN: 'anfashpara.cloudflareaccess.com',
          })
        ).status,
      ).toBe(401);
  });
  it.each(['system', 'user:admin', 'courier:manual'] as const)(
    'never lets actor %s set SETTLED',
    (actor) =>
      expect(() =>
        transition({ id: 'test', status: 'DELIVERED', noAnswerAttempts: 0 }, 'SETTLED', { actor }),
      ).toThrow(),
  );
  it('renders private French mobile pages and approval without public customer details', async () => {
    const response = await request('reconcile', input('T1,250,37,0,213,delivered'), false);
    const body = await response.text();
    expect(body).toContain('Écart supérieur à 1 MAD');
    expect(body).toContain('name="approval"');
    expect(body).toContain('name="confirmed"');
    expect(body).toContain('name="viewport"');
    expect(body).not.toContain('+212612345678');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
  it('supports the browser file preview and subsequent multipart approval', async () => {
    const value = input();
    const form = new FormData();
    for (const [key, content] of Object.entries(value))
      if (key !== 'source') form.set(key, content);
    form.set('file', new File([value.source], 'statement.csv'));
    const response = await createApp(access).request(
      `${origin}/admin/settlements/reconcile`,
      { method: 'POST', headers: { Accept: 'application/json', Origin: origin }, body: form },
      env,
    );
    expect(response.status).toBe(200);
    const { approval } = await response.json<{ approval: string }>();
    const approved = new FormData();
    for (const [key, content] of Object.entries(value)) approved.set(key, content);
    approved.set('approval', approval);
    approved.set('confirmed', 'true');
    expect(
      (
        await createApp(access).request(
          `${origin}/admin/settlements/import`,
          { method: 'POST', body: approved },
          env,
        )
      ).status,
    ).toBe(201);
  });
});
