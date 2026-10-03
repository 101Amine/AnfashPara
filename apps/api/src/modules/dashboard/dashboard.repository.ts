// apps/api/src/modules/dashboard/dashboard.repository.ts
import { dashboardWeek } from './dashboard.presenter';

const STORE = 'para-main';
export type DashboardMetrics = {
  placed: number;
  confirmed: number;
  delivered: number;
  refused: number;
};
export type DashboardPayout = { eligible: number; unknownFees: number; netCentimes: number };
export type DashboardSku = { sku: string; outcomes: number; refused: number };
export type DashboardCampaign = {
  campaign: string | null;
  content: string | null;
  orders: number;
  codCentimes: number;
};
export type DashboardStock = { sku: string; name: string; quantity: number };
export type DashboardData = {
  week: ReturnType<typeof dashboardWeek>;
  metrics: DashboardMetrics;
  payout: DashboardPayout;
  campaigns: DashboardCampaign[];
  refusals: DashboardSku[];
  stock: DashboardStock[];
  limits: { campaigns: number; refusals: number; stock: number };
};

// Static, bound queries. No customer table, raw payload or address is ever selected.
export const DASHBOARD_QUERIES = {
  metrics: `SELECT
    (SELECT COUNT(*) FROM orders WHERE store_id=? AND placed_at>=? AND placed_at<?) AS placed,
    (SELECT COUNT(*) FROM orders WHERE store_id=? AND confirmed_at>=? AND confirmed_at<?) AS confirmed,
    (SELECT COUNT(DISTINCT e.order_id) FROM order_events e JOIN orders o ON o.id=e.order_id AND o.store_id=e.store_id
      WHERE e.store_id=? AND e.to_status='DELIVERED' AND e.created_at>=? AND e.created_at<?) AS delivered,
    (SELECT COUNT(DISTINCT e.order_id) FROM order_events e JOIN orders o ON o.id=e.order_id AND o.store_id=e.store_id
      WHERE e.store_id=? AND e.to_status='REFUSED' AND e.created_at>=? AND e.created_at<?) AS refused`,
  payout: `SELECT COUNT(*) AS eligible,
    COALESCE(SUM(CASE WHEN s.delivery_fee_centimes IS NULL THEN 1 ELSE 0 END),0) AS unknownFees,
    COALESCE(SUM(CASE WHEN s.delivery_fee_centimes IS NOT NULL THEN o.cod_amount_centimes-s.delivery_fee_centimes ELSE 0 END),0) AS netCentimes
    FROM orders o JOIN shipments s ON s.order_id=o.id AND s.store_id=o.store_id
    WHERE o.store_id=? AND o.status='DELIVERED' AND s.status_normalized='delivered'
      AND NOT EXISTS(SELECT 1 FROM settlement_lines l WHERE l.store_id=o.store_id AND l.shipment_id=s.id AND l.line_status='matched')`,
  refusals: `WITH outcomes AS (
    SELECT e.order_id, MAX(CASE WHEN e.to_status='REFUSED' THEN 1 ELSE 0 END) AS refused
    FROM order_events e JOIN orders o ON o.id=e.order_id AND o.store_id=e.store_id
    WHERE e.store_id=? AND e.to_status IN ('DELIVERED','REFUSED') AND e.created_at>=? AND e.created_at<? GROUP BY e.order_id
  ), items AS (SELECT DISTINCT order_id,sku FROM order_items WHERE store_id=?)
    SELECT i.sku, COUNT(*) AS outcomes, SUM(o.refused) AS refused FROM outcomes o JOIN items i ON i.order_id=o.order_id
    GROUP BY i.sku ORDER BY CAST(SUM(o.refused) AS REAL)/COUNT(*) DESC,i.sku LIMIT 20`,
  campaigns: `SELECT NULLIF(TRIM(utm_campaign),'') AS campaign, NULLIF(TRIM(utm_content),'') AS content,
    COUNT(*) AS orders, SUM(cod_amount_centimes) AS codCentimes FROM orders
    WHERE store_id=? AND placed_at>=? AND placed_at<?
    GROUP BY NULLIF(TRIM(utm_campaign),''),NULLIF(TRIM(utm_content),'') ORDER BY orders DESC,campaign,content LIMIT 20`,
  stock: `SELECT p.sku,p.name,COALESCE(SUM(m.quantity),0) AS quantity
    FROM products p LEFT JOIN inventory_movements m ON m.sku=p.sku AND m.store_id=p.store_id
    WHERE p.store_id=? GROUP BY p.sku,p.name ORDER BY p.sku LIMIT 50`,
} as const;

export async function loadDashboard(
  database: D1Database,
  now = new Date(),
): Promise<DashboardData> {
  const week = dashboardWeek(now);
  // Half-open intervals, with an as-of cut-off to exclude incorrectly future-dated events.
  const end = week.asOf < week.end ? week.asOf : week.end;
  const interval = [STORE, week.start, end];
  const result = await database.batch([
    database
      .prepare(DASHBOARD_QUERIES.metrics)
      .bind(...interval, ...interval, ...interval, ...interval),
    database.prepare(DASHBOARD_QUERIES.payout).bind(STORE),
    database.prepare(DASHBOARD_QUERIES.refusals).bind(...interval, STORE),
    database.prepare(DASHBOARD_QUERIES.campaigns).bind(...interval),
    database.prepare(DASHBOARD_QUERIES.stock).bind(STORE),
  ]);
  if (result.some((r) => !r.success)) throw new Error('Dashboard query failed');
  const metrics = result[0]?.results[0] as DashboardMetrics;
  const payout = result[1]?.results[0] as DashboardPayout;
  const campaigns = result[3]?.results as DashboardCampaign[];
  for (const amount of [payout.netCentimes, ...campaigns.map((c) => c.codCentimes)]) {
    if (!Number.isSafeInteger(amount)) throw new RangeError('Unsafe aggregate amount');
  }
  return {
    week,
    metrics,
    payout,
    campaigns,
    refusals: result[2]?.results as DashboardSku[],
    stock: result[4]?.results as DashboardStock[],
    limits: { campaigns: 20, refusals: 20, stock: 50 },
  };
}
