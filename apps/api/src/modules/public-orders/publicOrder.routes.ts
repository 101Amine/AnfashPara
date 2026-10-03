// apps/api/src/modules/public-orders/publicOrder.routes.ts
import type { Context, Hono } from 'hono';

import type { AppEnvironment } from '../../auth/cloudflareAccess';
import { publicOrderRateLimiter, type OrderRateLimiter } from './publicOrder.rateLimit';
import { publicOrderSchema } from './publicOrder.schema';
import {
  createPublicOrder,
  IdempotencyConflictError,
  OrderIngestionValidationError,
} from './publicOrder.service';

const MAX_BODY_BYTES = 16 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

export function registerPublicOrderRoutes(
  app: Hono<AppEnvironment>,
  rateLimiter: OrderRateLimiter = publicOrderRateLimiter,
): void {
  app.post('/api/orders', async (context) => {
    if (!context.env.DB) return serviceUnavailable(context);

    const rateLimit = rateLimiter.consume(context.req.header('CF-Connecting-IP') ?? 'unknown');
    if (!rateLimit.allowed) {
      context.header('Retry-After', String(rateLimit.retryAfterSeconds));
      return context.json(
        { error: { code: 'rate_limit_exceeded', message: 'Too many order attempts' } },
        429,
      );
    }

    const idempotencyKey = context.req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return context.json(
        {
          error: {
            code: 'invalid_idempotency_key',
            message: 'Idempotency-Key must contain 8 to 128 safe characters',
          },
        },
        400,
      );
    }

    const contentType = context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return context.json(
        {
          error: {
            code: 'unsupported_media_type',
            message: 'Content-Type must be application/json',
          },
        },
        415,
      );
    }

    const declaredLength = Number(context.req.header('Content-Length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return payloadTooLarge(context);
    }

    const rawPayload = await context.req.text();
    if (new TextEncoder().encode(rawPayload).byteLength > MAX_BODY_BYTES) {
      return payloadTooLarge(context);
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

    const parsedPayload = publicOrderSchema.safeParse(decodedPayload);
    if (!parsedPayload.success) {
      return context.json(
        { error: { code: 'invalid_payload', message: 'Invalid order payload' } },
        400,
      );
    }

    try {
      const result = await createPublicOrder(context.env.DB, idempotencyKey, parsedPayload.data);
      return context.json(result, result.duplicate ? 200 : 201);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return context.json(
          { error: { code: 'idempotency_conflict', message: error.message } },
          409,
        );
      }
      if (error instanceof OrderIngestionValidationError) {
        return context.json({ error: { code: error.code, message: error.message } }, 422);
      }
      return serviceUnavailable(context);
    }
  });
}

function serviceUnavailable(context: Context<AppEnvironment>) {
  return context.json(
    { error: { code: 'service_unavailable', message: 'Service unavailable' } },
    503,
  );
}

function payloadTooLarge(context: Context<AppEnvironment>) {
  return context.json(
    { error: { code: 'payload_too_large', message: 'Order payload exceeds 16 KiB' } },
    413,
  );
}
