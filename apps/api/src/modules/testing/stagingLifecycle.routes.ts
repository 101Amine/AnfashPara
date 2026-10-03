// apps/api/src/modules/testing/stagingLifecycle.routes.ts
import { z } from 'zod';
import type { Hono } from 'hono';
import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { createUuidV7 } from '../../shared/uuidV7';

const runSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const STORE = 'para-main';
export function registerStagingLifecycleRoutes(app: Hono<AppEnvironment>): void {
  app.use('/admin/testing/lifecycle', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    if (
      c.env.ENVIRONMENT !== 'staging' ||
      new URL(c.req.url).hostname !== 'para-api-staging.alanfashpara.workers.dev'
    )
      return c.json({ error: 'Not found' }, 404);
    await next();
  });
  app.get('/admin/testing/lifecycle', async (c) => {
    if ((c.env.COURIER_MODE ?? 'manual') !== 'manual')
      return c.json({ error: 'Manual staging mode required' }, 409);
    if (!c.env.DB) return c.json({ error: 'Database unavailable' }, 503);
    const run = c.req.query('run');
    if (run === undefined)
      return c.json({ environment: 'staging', gitSha: c.env.GIT_SHA, mode: 'manual' });
    const parsed = runSchema.safeParse(run);
    if (!parsed.success) return c.json({ error: 'Invalid run' }, 400);
    try {
      return c.json({ orders: await report(c.env.DB, parsed.data) });
    } catch {
      return c.json({ error: 'Report unavailable' }, 503);
    }
  });
  app.post('/admin/testing/lifecycle', async (c) => {
    if (c.req.header('Origin') !== new URL(c.req.url).origin)
      return c.json({ error: 'Forbidden' }, 403);
    const text = await c.req.text();
    if (text.length > 512) return c.json({ error: 'Request too large' }, 413);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const input = z.strictObject({ run: runSchema, action: z.literal('archive') }).safeParse(value);
    if (!input.success) return c.json({ error: 'Invalid request' }, 400);
    if (!c.env.DB) return c.json({ error: 'Database unavailable' }, 503);
    try {
      const rows = await report(c.env.DB, input.data.run);
      if (rows.length !== 5) return c.json({ error: 'Incomplete run; preserve evidence' }, 409);
      // Archive only explicitly tagged synthetic orders. Never delete audit evidence.
      const prefix = `STG-${input.data.run}-`;
      const timestamp = new Date().toISOString();
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO inventory_movements(id,store_id,sku,quantity,reason,reference,created_at)
          SELECT substr(?,1,24)||lower(hex(randomblob(6))),?,m.sku,-SUM(m.quantity),'adjustment',?,? FROM inventory_movements m
          JOIN orders o ON m.reference IN ('order:'||o.id||':shipped','order:'||o.id||':returned') AND m.store_id=o.store_id
          WHERE o.store_id=? AND o.order_number LIKE ? AND o.utm_campaign=? AND o.utm_source='staging-test'
          AND o.address='Adresse test staging - ne pas livrer' AND o.note='STAGING_LIFECYCLE'
          GROUP BY m.sku HAVING SUM(m.quantity)<>0
          ON CONFLICT DO NOTHING`,
        ).bind(
          createUuidV7(),
          STORE,
          `staging:${input.data.run}:archive`,
          timestamp,
          STORE,
          `${prefix}%`,
          input.data.run,
        ),
        c.env.DB.prepare(
          `UPDATE outbox SET status='failed',attempts=5,next_attempt_at=NULL,last_error='staging_archived',updated_at=?
          WHERE status!='done' AND store_id=? AND aggregate_id IN (
            SELECT o.id FROM orders o WHERE o.store_id=? AND o.order_number LIKE ?
            AND o.utm_campaign=? AND o.utm_source='staging-test' AND o.address='Adresse test staging - ne pas livrer' AND o.note='STAGING_LIFECYCLE'
            UNION SELECT s.id FROM shipments s JOIN orders o ON o.id=s.order_id AND o.store_id=s.store_id
            WHERE o.store_id=? AND o.order_number LIKE ? AND o.utm_campaign=? AND o.utm_source='staging-test'
            AND o.address='Adresse test staging - ne pas livrer' AND o.note='STAGING_LIFECYCLE')`,
        ).bind(
          timestamp,
          STORE,
          STORE,
          `${prefix}%`,
          input.data.run,
          STORE,
          `${prefix}%`,
          input.data.run,
        ),
        c.env.DB.prepare(
          `UPDATE orders SET note='STAGING_LIFECYCLE_ARCHIVED' WHERE store_id=? AND order_number LIKE ?
          AND utm_campaign=? AND utm_source='staging-test' AND address='Adresse test staging - ne pas livrer' AND note='STAGING_LIFECYCLE'`,
        ).bind(STORE, `${prefix}%`, input.data.run),
      ]);
      return c.json({ archived: true });
    } catch {
      return c.json({ error: 'Archive unavailable; preserve run reference' }, 503);
    }
  });
}
async function report(database: D1Database, run: string) {
  return (
    await database
      .prepare(
        `SELECT o.id,o.order_number AS orderNumber,o.status,
    (SELECT c.orders_count FROM customers c WHERE c.id=o.customer_id AND c.store_id=o.store_id) AS customerOrders,
    (SELECT c.delivered_count FROM customers c WHERE c.id=o.customer_id AND c.store_id=o.store_id) AS customerDelivered,
    (SELECT c.refused_count FROM customers c WHERE c.id=o.customer_id AND c.store_id=o.store_id) AS customerRefused,
    (SELECT COUNT(*) FROM webhook_inbox w WHERE w.store_id=o.store_id AND w.external_event_id LIKE 'stg-courier-'||o.utm_campaign||'-%'
      AND json_extract(w.payload_json,'$.trackingNumber')=(SELECT s.tracking_number FROM shipments s WHERE s.order_id=o.id AND s.store_id=o.store_id LIMIT 1)) AS inboxCount,
    (SELECT COUNT(*) FROM confirmation_attempts a WHERE a.order_id=o.id AND a.store_id=o.store_id) AS attempts,
    (SELECT COUNT(*) FROM order_events e WHERE e.order_id=o.id AND e.store_id=o.store_id) AS orderEvents,
    (SELECT COUNT(*) FROM shipment_events e JOIN shipments s ON s.id=e.shipment_id AND s.store_id=e.store_id WHERE s.order_id=o.id AND s.store_id=o.store_id) AS shipmentEvents,
    (SELECT COUNT(*) FROM inventory_movements m WHERE m.store_id=o.store_id AND m.reference IN ('order:'||o.id||':shipped','order:'||o.id||':returned')) AS movements,
    (SELECT COUNT(*) FROM shipments s WHERE s.order_id=o.id AND s.store_id=o.store_id) AS shipments,
    (SELECT s.id FROM shipments s WHERE s.order_id=o.id AND s.store_id=o.store_id LIMIT 1) AS shipmentId,
    o.note='STAGING_LIFECYCLE_ARCHIVED' AS archived
    FROM orders o WHERE o.store_id=? AND o.order_number LIKE ? AND o.utm_campaign=? AND o.utm_source='staging-test'
    AND o.address='Adresse test staging - ne pas livrer' AND o.note IN ('STAGING_LIFECYCLE','STAGING_LIFECYCLE_ARCHIVED') ORDER BY o.order_number LIMIT 6`,
      )
      .bind(STORE, `STG-${run}-%`, run)
      .all()
  ).results;
}
