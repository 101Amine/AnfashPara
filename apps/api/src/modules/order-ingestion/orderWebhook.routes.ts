// apps/api/src/modules/order-ingestion/orderWebhook.routes.ts
import type { Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { orderWebhookSchema } from './orderWebhook.schema';
import { ingestOrderWebhook, OrderIngestionValidationError } from './orderWebhook.service';
import {
  ORDER_WEBHOOK_SIGNATURE_HEADER,
  verifyOrderWebhookSignature,
} from './orderWebhook.signature';

export function registerOrderWebhookRoutes(app: Hono<AppEnvironment>): void {
  app.post('/api/webhooks/orders', async (context) => {
    const secret = context.env.ORDER_WEBHOOK_SECRET;
    if (!secret || !context.env.DB) {
      return context.json(
        { error: { code: 'service_unavailable', message: 'Service unavailable' } },
        503,
      );
    }

    const rawPayload = await context.req.text();
    const validSignature = await verifyOrderWebhookSignature(
      rawPayload,
      context.req.header(ORDER_WEBHOOK_SIGNATURE_HEADER),
      secret,
    );

    if (!validSignature) {
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

    const parsedPayload = orderWebhookSchema.safeParse(decodedPayload);
    if (!parsedPayload.success) {
      return context.json(
        { error: { code: 'invalid_payload', message: 'Invalid webhook payload' } },
        400,
      );
    }

    try {
      const result = await ingestOrderWebhook(context.env.DB, rawPayload, parsedPayload.data);

      if (result.duplicate) {
        return context.json({ duplicate: true });
      }

      return context.json(result, 201);
    } catch (error) {
      if (error instanceof OrderIngestionValidationError) {
        return context.json({ error: { code: error.code, message: error.message } }, 422);
      }

      return context.json(
        { error: { code: 'service_unavailable', message: 'Service unavailable' } },
        503,
      );
    }
  });
}
