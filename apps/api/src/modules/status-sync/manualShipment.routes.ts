// apps/api/src/modules/status-sync/manualShipment.routes.ts
import type { Context, Hono } from 'hono';
import { html } from 'hono/html';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { manualShipmentActionSchema, manualShipmentIdsSchema } from './manualShipment.schema';
import {
  ShipmentNotFoundError,
  ShipmentStatusTransitionError,
  synchronizeCourierStatus,
} from './statusSync.service';

export function registerManualShipmentRoutes(app: Hono<AppEnvironment>): void {
  app.post('/admin/orders/:orderId/shipments/:shipmentId/status', async (context) => {
    context.header('Cache-Control', 'private, no-store, max-age=0');
    context.header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
    const json = context.req.header('Content-Type')?.includes('application/json') ?? false;
    const respond = (status: 400 | 403 | 404 | 409 | 503, code: string, message: string) =>
      result(context, json, status, code, message);
    // Browser forms must come from this origin. JSON callers still require the Access JWT.
    const origin = context.req.header('Origin');
    if (origin !== undefined && origin !== new URL(context.req.url).origin) {
      return respond(403, 'invalid_origin', 'Action non autorisée depuis ce site.');
    }
    if (!json && origin === undefined) {
      return respond(403, 'invalid_origin', 'Rechargez la file des commandes puis réessayez.');
    }
    if (!context.env.DB) return respond(503, 'service_unavailable', 'Service indisponible.');
    const ids = manualShipmentIdsSchema.safeParse(context.req.param());
    if (!ids.success) return respond(400, 'invalid_ids', 'Commande ou colis invalide.');
    let body: unknown;
    try {
      body = json ? await context.req.json() : await context.req.parseBody();
    } catch {
      return respond(400, 'invalid_request', 'Action invalide.');
    }
    const parsed = manualShipmentActionSchema.safeParse(body);
    if (!parsed.success) return respond(400, 'invalid_action', 'Action invalide.');
    try {
      const shipment = await context.env.DB.prepare(
        'SELECT tracking_number FROM shipments WHERE id = ? AND order_id = ? AND store_id = ?',
      )
        .bind(ids.data.shipmentId, ids.data.orderId, 'para-main')
        .first<{ tracking_number: string }>();
      if (shipment === null) return respond(404, 'shipment_not_found', 'Colis introuvable.');
      if (!shipment.tracking_number.startsWith('SELF-')) {
        return respond(409, 'not_manual_shipment', 'Ce colis est suivi par le transporteur.');
      }
      const now = new Date();
      const action = parsed.data.action;
      const outcome = await synchronizeCourierStatus(
        context.env.DB,
        {
          ...ids.data,
          actor: `user:${context.get('accessIdentity').email}`,
          eventId: `manual:${ids.data.shipmentId}:${action}`,
          normalizedStatus: action,
          occurredAt: now.toISOString(),
          rawPayload: JSON.stringify({
            ...ids.data,
            action,
            actor: context.get('accessIdentity').email,
          }),
          rawStatus: `MANUAL_${action.toUpperCase()}`,
          source: 'manual',
          trackingNumber: shipment.tracking_number,
        },
        now,
      );
      if (json) return context.json(outcome);
      return result(
        context,
        false,
        200,
        outcome.duplicate ? 'duplicate' : 'updated',
        outcome.duplicate ? 'Cette action a déjà été enregistrée.' : 'Statut du colis mis à jour.',
      );
    } catch (error) {
      if (error instanceof ShipmentNotFoundError)
        return respond(404, 'shipment_not_found', 'Colis introuvable.');
      if (error instanceof ShipmentStatusTransitionError)
        return respond(
          409,
          'illegal_transition',
          'Cette action n’est plus autorisée pour ce statut. Rechargez la file des commandes.',
        );
      return respond(503, 'service_unavailable', 'Service indisponible. Vous pouvez réessayer.');
    }
  });
}

function result(
  context: Context<AppEnvironment>,
  json: boolean,
  status: 200 | 400 | 403 | 404 | 409 | 503,
  code: string,
  message: string,
): Response | Promise<Response> {
  if (json) return context.json({ error: { code, message } }, status);
  return context.html(
    html`<!doctype html>
      <html lang="fr">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Suivi du colis</title>
          <style>
            body {
              font: 18px system-ui;
              max-width: 600px;
              margin: 40px auto;
              padding: 20px;
            }
            a {
              display: inline-block;
              padding: 16px 0;
            }
          </style>
        </head>
        <body>
          <h1>Suivi du colis</h1>
          <p role="status">${message}</p>
          <a href="/admin/orders">Retour aux commandes</a>
        </body>
      </html>`,
    status,
  );
}
