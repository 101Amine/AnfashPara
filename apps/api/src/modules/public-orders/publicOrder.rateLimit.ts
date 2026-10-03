// apps/api/src/modules/public-orders/publicOrder.rateLimit.ts
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
