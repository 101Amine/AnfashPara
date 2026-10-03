// apps/api/src/modules/status-sync/courierWebhook.routes.ts
import type { Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { mapCourierStatus } from './courierStatus.mapper';
import { courierWebhookSchema } from './courierWebhook.schema';
import {
  COURIER_WEBHOOK_SIGNATURE_HEADER,
  verifyCourierWebhookSignature,
} from './courierWebhook.signature';
import {
  ShipmentNotFoundError,
  ShipmentStatusTransitionError,
  synchronizeCourierStatus,
} from './statusSync.service';

export function registerCourierWebhookRoutes(app: Hono<AppEnvironment>): void {
  app.post('/api/webhooks/courier', async (context) => {
    const secret = context.env.COURIER_WEBHOOK_SECRET;
    if (!secret || !context.env.DB) {
      return context.json(
        { error: { code: 'service_unavailable', message: 'Service unavailable' } },
        503,
      );
    }

    const rawPayload = await context.req.text();
    const signatureValid = await verifyCourierWebhookSignature(
      rawPayload,
      context.req.header(COURIER_WEBHOOK_SIGNATURE_HEADER),
      secret,
    );
    if (!signatureValid) {
      return context.json(
        { error: { code: 'invalid_signature', message: 'Invalid webhook signature' } },
        401,
      );
    }

    let decodedPayload: unknown;
    try {
      decodedPayload = JSON.parse(rawPayload);
    } catch {
      return context.json(
        { error: { code: 'malformed_payload', message: 'Malformed JSON payload' } },
        400,
      );
    }

    const payload = courierWebhookSchema.safeParse(decodedPayload);
    if (!payload.success) {
      return context.json(
        { error: { code: 'invalid_payload', message: 'Invalid webhook payload' } },
        400,
      );
    }

    const normalizedStatus = mapCourierStatus(payload.data.status);
    if (normalizedStatus === null) {
      return context.json(
        { error: { code: 'unsupported_status', message: 'Unsupported courier status' } },
        422,
      );
    }

    try {
      const result = await synchronizeCourierStatus(context.env.DB, {
        eventId: payload.data.eventId,
        normalizedStatus,
        occurredAt: payload.data.occurredAt,
        rawPayload,
        rawStatus: payload.data.status,
        source: 'webhook',
        trackingNumber: payload.data.trackingNumber,
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof ShipmentNotFoundError) {
        return context.json(
          { error: { code: 'shipment_not_found', message: 'Shipment not found' } },
          404,
        );
      }
      if (error instanceof ShipmentStatusTransitionError) {
        return context.json(
          {
            error: {
              code: 'invalid_status_transition',
              message: 'Courier status is incompatible with the current order state',
            },
          },
          409,
        );
      }
      return context.json(
        { error: { code: 'service_unavailable', message: 'Service unavailable' } },
        503,
      );
    }
  });
}
