// apps/api/test/dashboard.spec.ts
import { env } from 'cloudflare:test';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import migration0 from '../migrations/0000_lethal_jamie_braddock.sql?raw';
import migration1 from '../migrations/0001_faithful_medusa.sql?raw';
import migration2 from '../migrations/0002_full_order_schema.sql?raw';
import migration3 from '../migrations/0003_sparkling_iron_fist.sql?raw';
import migration4 from '../migrations/0004_rainy_loki.sql?raw';
import migration5 from '../migrations/0005_even_lilith.sql?raw';
import migration6 from '../migrations/0006_silent_kulan_gath.sql?raw';
import type { AppEnvironment } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';
import {
  dashboardWeek,
  dashboardMoney,
  refusalRate,
} from '../src/modules/dashboard/dashboard.presenter';
import { DASHBOARD_QUERIES, loadDashboard } from '../src/modules/dashboard/dashboard.repository';
import { renderDashboard } from '../src/modules/dashboard/dashboard.view';

const now = new Date('2026-10-03T12:00:00.000Z');
const ts = '2026-10-01T12:00:00.000Z';
const uuid = (n: number) => `0199b001-1000-7000-8000-${String(n).padStart(12, '0')}`;
const access: MiddlewareHandler<AppEnvironment> = async (c, next) => {
  c.set('accessIdentity', { email: 'admin@example.test', subject: 'test' });
  await next();
};
beforeEach(async () => {
  for (const table of [
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
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const migration of [
    migration0,
    migration1,
    migration2,
    migration3,
    migration4,
    migration5,
    migration6,
  ])
    for (const statement of migration.split('--> statement-breakpoint').filter((s) => s.trim()))
      await env.DB.prepare(statement).run();
  await env.DB.prepare(
    `INSERT INTO products(id,store_id,sku,slug,name,price_centimes,cogs_centimes,active,created_at,updated_at)
    VALUES ('product','para-main','SKU-1','product','<script>private</script>',25000,5000,1,?,?)`,
  )
    .bind(ts, ts)
    .run();
  await env.DB.prepare(
    `INSERT INTO customers(id,store_id,phone_e164,name,created_at,updated_at)
    VALUES (?,'para-main','+212612345678','PRIVATE-CUSTOMER',?,?)`,
  )
    .bind(uuid(1), ts, ts)
    .run();
});
afterEach(() => vi.useRealTimers());
async function order(
  n: number,
  status = 'CONFIRMING',
  placed = ts,
  store = 'para-main',
  fee: number | null = 3000,
) {
  await env.DB.prepare(
    `INSERT INTO orders(id,store_id,external_id,customer_id,status,cod_amount_centimes,
    placed_at,confirmed_at,utm_campaign,utm_content,raw_payload_json,created_at,updated_at)
    VALUES (?,?,?,?,?,25000,?,?,?,?,'{}',?,?)`,
  )
    .bind(
      uuid(n),
      store,
      `external-${n}`,
      uuid(1),
      status,
      placed,
      status === 'CONFIRMING' ? null : ts,
      'demo',
      'video',
      ts,
      ts,
    )
    .run();
  if (status === 'DELIVERED' || status === 'SETTLED')
    await env.DB.prepare(
      `INSERT INTO shipments(id,store_id,order_id,courier,tracking_number,status_normalized,delivery_fee_centimes,created_at,updated_at)
      VALUES (?,?,?,'manual',?,'delivered',?,?,?)`,
    )
      .bind(uuid(n + 100), store, uuid(n), `T${n}`, fee, ts, ts)
      .run();
}
async function event(n: number, orderId: number, status: string, date = ts, store = 'para-main') {
  await env.DB.prepare(
    `INSERT INTO order_events(id,store_id,order_id,to_status,actor,created_at)
    VALUES (?,?,?,?,'user:admin@example.test',?)`,
  )
    .bind(uuid(n + 200), store, uuid(orderId), status, date)
    .run();
}
async function item(n: number, orderId: number, quantity = 1) {
  await env.DB.prepare(
    `INSERT INTO order_items(id,store_id,order_id,sku,quantity,unit_price_centimes,unit_cogs_centimes,created_at)
    VALUES (?,'para-main',?,'SKU-1',?,25000,5000,?)`,
  )
    .bind(uuid(n + 300), uuid(orderId), quantity, ts)
    .run();
}
describe('Casablanca dashboard presenter', () => {
  it('resolves Monday in local time before UTC Monday', () => {
    expect(dashboardWeek(new Date('2026-09-27T23:30:00.000Z')).start).toBe(
      '2026-09-27T23:00:00.000Z',
    );
    expect(dashboardWeek(new Date('2026-09-27T22:59:59.999Z')).start).toBe(
      '2026-09-20T23:00:00.000Z',
    );
  });
  it('resolves each endpoint across Ramadan offset changes', () => {
    const suspension = dashboardWeek(new Date('2026-02-12T12:00:00.000Z'));
    const resumption = dashboardWeek(new Date('2026-03-19T12:00:00.000Z'));
    expect(suspension.start).toBe('2026-02-08T23:00:00.000Z');
    expect(suspension.end).toBe('2026-02-16T00:00:00.000Z');
    expect(resumption.start).toBe('2026-03-16T00:00:00.000Z');
    expect(resumption.end).toBe('2026-03-22T23:00:00.000Z');
  });
  it('handles the year boundary and invalid dates', () => {
    expect(dashboardWeek(new Date('2027-01-01T10:00:00Z')).start).toBe('2026-12-27T23:00:00.000Z');
    expect(() => dashboardWeek(new Date('invalid'))).toThrow(RangeError);
  });
  it('formats centimes only at the view edge and handles empty denominators', () => {
    expect(dashboardMoney(12345)).toContain('123');
    expect(dashboardMoney(12345)).toContain('45');
    expect(() => dashboardMoney(1.5)).toThrow(RangeError);
    expect(refusalRate(0, 0)).toBe('—');
    expect(refusalRate(1, 4)).toContain('25');
  });
});
describe('dashboard trusted read model', () => {
  it('rejects unsafe aggregate centimes rather than returning rounded money', async () => {
    await order(2);
    await order(3);
    await env.DB.prepare('UPDATE orders SET cod_amount_centimes=?')
      .bind(Number.MAX_SAFE_INTEGER)
      .run();
    await expect(loadDashboard(env.DB, now)).rejects.toThrow('Unsafe aggregate amount');
  });
  it('bounds catalogue results and keeps inactive and negative-stock products visible', async () => {
    const inserts = Array.from({ length: 55 }, (_, n) =>
      env.DB.prepare(
        `INSERT INTO products(id,store_id,sku,slug,name,price_centimes,cogs_centimes,active,created_at,updated_at)
      VALUES (?,'para-main',?,?,?,100,50,0,?,?)`,
      ).bind(
        `product-${n}`,
        `SKU-${String(n + 2).padStart(3, '0')}`,
        `slug-${n}`,
        `Produit ${n}`,
        ts,
        ts,
      ),
    );
    await env.DB.batch(inserts);
    await env.DB.prepare(
      `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,created_at)
      VALUES (?,'para-main','SKU-002',-2,'damaged',?)`,
    )
      .bind(uuid(900), ts)
      .run();
    const data = await loadDashboard(env.DB, now);
    expect(data.stock).toHaveLength(50);
    expect(data.stock.find((p) => p.sku === 'SKU-002')?.quantity).toBe(-2);
    expect(data.limits.stock).toBe(50);
  });
  it('counts distinct outcomes, confirmed activity, cohort COD and ledger stock without multiplying items', async () => {
    await order(2, 'DELIVERED');
    await order(3, 'RETURNED');
    await order(4);
    await order(5, 'SETTLED', '2026-09-01T00:00:00.000Z');
    await event(1, 2, 'DELIVERED');
    await event(2, 2, 'DELIVERED');
    await event(3, 3, 'REFUSED');
    await event(4, 3, 'RETURNED');
    await event(5, 5, 'DELIVERED');
    await item(1, 2, 3);
    await item(2, 2);
    await item(3, 3, 2);
    await item(4, 5);
    for (const [n, q, reason] of [
      [1, 10, 'purchase'],
      [2, -2, 'shipped'],
      [3, 2, 'returned'],
      [4, -1, 'damaged'],
    ] as const)
      await env.DB.prepare(
        `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,created_at) VALUES (?,'para-main','SKU-1',?,?,?)`,
      )
        .bind(uuid(n + 400), q, reason, ts)
        .run();
    const data = await loadDashboard(env.DB, now);
    expect(data.metrics).toEqual({ placed: 3, confirmed: 3, delivered: 2, refused: 1 });
    expect(data.payout).toEqual({ eligible: 1, unknownFees: 0, netCentimes: 22000 });
    expect(data.refusals).toEqual([{ sku: 'SKU-1', outcomes: 3, refused: 1 }]);
    expect(data.campaigns[0]).toEqual({
      campaign: 'demo',
      content: 'video',
      orders: 3,
      codCentimes: 75000,
    });
    expect(data.stock[0]?.quantity).toBe(9);
  });
  it('uses half-open boundaries, excludes future activity and isolates stores', async () => {
    const start = dashboardWeek(now).start;
    await order(2, 'CONFIRMING', start);
    await order(3, 'CONFIRMING', '2026-09-27T22:59:59.999Z');
    await order(4, 'CONFIRMING', '2026-10-05T00:00:00.000Z');
    await order(5, 'DELIVERED', ts, 'other');
    await event(1, 2, 'DELIVERED', start);
    await event(2, 2, 'REFUSED', now.toISOString());
    await event(3, 3, 'REFUSED', '2026-09-27T22:59:59.999Z');
    await event(4, 5, 'DELIVERED', ts, 'other');
    expect((await loadDashboard(env.DB, now)).metrics).toEqual({
      placed: 1,
      confirmed: 0,
      delivered: 1,
      refused: 0,
    });
    expect((await loadDashboard(env.DB, now)).payout.eligible).toBe(0);
  });
  it('does not assume a missing fee is zero and excludes matched or settled deliveries', async () => {
    await order(2, 'DELIVERED', ts, 'para-main', null);
    await order(3, 'SETTLED');
    await order(4, 'DELIVERED');
    await env.DB.prepare(
      `INSERT INTO courier_settlements(id,store_id,courier,statement_reference,period_start,period_end,amount_paid_centimes,imported_at)
      VALUES (?,'para-main','manual','TEST','2026-10-01','2026-10-03',22000,?)`,
    )
      .bind(uuid(500), ts)
      .run();
    await env.DB.prepare(
      `INSERT INTO settlement_lines(id,store_id,settlement_id,tracking_number,cod_collected_centimes,fee_centimes,net_centimes,expected_fee_centimes,line_status,shipment_id,created_at)
      VALUES (?,'para-main',?,'T4',25000,3000,22000,3000,'matched',?,?)`,
    )
      .bind(uuid(501), uuid(500), uuid(104), ts)
      .run();
    expect((await loadDashboard(env.DB, now)).payout).toEqual({
      eligible: 1,
      unknownFees: 1,
      netCentimes: 0,
    });
  });
  it('renders clear empty states and escapes catalogue/attribution strings', async () => {
    let data = await loadDashboard(env.DB, now);
    expect(String(await renderDashboard(data))).toContain('Aucune livraison en attente');
    expect(String(await renderDashboard(data))).toContain('Aucune issue de livraison');
    await order(2);
    await env.DB.prepare(
      `UPDATE orders SET utm_campaign='<script>alert(1)</script>',utm_content=NULL WHERE id=?`,
    )
      .bind(uuid(2))
      .run();
    data = await loadDashboard(env.DB, now);
    const output = String(await renderDashboard(data));
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('Non attribué');
  });
  it('uses existing indexes without speculative schema changes', async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${DASHBOARD_QUERIES.payout}`)
      .bind('para-main')
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join('\n');
    expect(details).toContain('shipments_store_status_index');
    expect(details).toContain('sqlite_autoindex_orders_1');
    expect(details).toContain('settlement_lines_shipment_index');
    const stockPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${DASHBOARD_QUERIES.stock}`)
      .bind('para-main')
      .all<{ detail: string }>();
    expect(stockPlan.results.map((r) => r.detail).join('\n')).toContain(
      'inventory_store_sku_created_index',
    );
  });
});
describe('private dashboard HTTP boundary', () => {
  it('requires Worker Access verification', async () => {
    expect(
      (await createApp().request('https://example.com/admin/dashboard', {}, env)).status,
    ).not.toBe(200);
  });
  it('returns aggregate JSON only with private no-store and no customer details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await order(2);
    const response = await createApp(access).request(
      'https://example.com/admin/dashboard',
      { headers: { Accept: 'application/json' } },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('Vary')).toContain('Cf-Access-Jwt-Assertion');
    const body = await response.text();
    expect(body).not.toContain('PRIVATE-CUSTOMER');
    expect(body).not.toContain('+212');
    expect(body).not.toContain('raw_payload');
    expect(body).not.toContain('customer_id');
  });
  it('serves French mobile HTML and sanitizes database failures', async () => {
    const app = createApp(access);
    const good = await app.request('https://example.com/admin/dashboard', {}, env);
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('width=device-width');
    await env.DB.prepare('DROP TABLE settlement_lines').run();
    const bad = await app.request('https://example.com/admin/dashboard', {}, env);
    expect(bad.status).toBe(503);
    expect(bad.headers.get('Cache-Control')).toContain('no-store');
    expect(await bad.text()).not.toContain('SQLITE');
  });
});
