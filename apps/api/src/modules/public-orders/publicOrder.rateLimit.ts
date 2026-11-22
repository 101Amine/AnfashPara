// apps/api/src/modules/public-orders/publicOrder.rateLimit.ts
import type { AppBindings } from '../../auth/cloudflareAccess';

// Cloudflare supplies the client IP at the edge. Never use X-Forwarded-For or a body field.
export async function consumeOrderRateLimit(
  bindings: Pick<AppBindings, 'ORDER_RATE_LIMITER' | 'ENVIRONMENT'>,
  clientIp: string | undefined,
  localLimiter: OrderRateLimiter,
): Promise<RateLimitResult> {
  if (bindings.ORDER_RATE_LIMITER) {
    if (!clientIp?.trim()) throw new Error('Client address unavailable');
    const { success } = await bindings.ORDER_RATE_LIMITER.limit({
      key: `checkout:${clientIp.trim()}`,
    });
    return success ? { allowed: true } : { allowed: false, retryAfterSeconds: 60 };
  }
  // Explicit local development only: never silently weaken a deployed environment.
  if (bindings.ENVIRONMENT !== 'local') throw new Error('Checkout rate limiter unavailable');
  return localLimiter.consume(clientIp ?? 'unknown');
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type OrderRateLimiter = {
  consume(key: string, now?: number): RateLimitResult;
};

type Window = {
  count: number;
  startedAt: number;
};

type RateLimiterOptions = {
  limit: number;
  maxKeys: number;
  windowMs: number;
};

export function createFixedWindowRateLimiter({
  limit,
  maxKeys,
  windowMs,
}: RateLimiterOptions): OrderRateLimiter {
  const windows = new Map<string, Window>();

  return {
    consume(key, now = Date.now()): RateLimitResult {
      const current = windows.get(key);
      if (!current || now - current.startedAt >= windowMs) {
        if (windows.size >= maxKeys) {
          const oldestKey = windows.keys().next().value as string | undefined;
          if (oldestKey !== undefined) windows.delete(oldestKey);
        }
        windows.set(key, { count: 1, startedAt: now });
        return { allowed: true };
      }

      if (current.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)),
        };
      }

      current.count += 1;
      return { allowed: true };
    },
  };
}

export const publicOrderRateLimiter = createFixedWindowRateLimiter({
  limit: 10,
  maxKeys: 10_000,
  windowMs: 60_000,
});
