// apps/api/test/publicOrderRateLimit.spec.ts
import { describe, expect, it } from 'vitest';

import { createFixedWindowRateLimiter } from '../src/modules/public-orders/publicOrder.rateLimit';

describe('public order rate limiter', () => {
  it('limits a burst per client and resets after the window', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 2, maxKeys: 10, windowMs: 10_000 });

    expect(limiter.consume('client', 1000)).toEqual({ allowed: true });
    expect(limiter.consume('client', 1001)).toEqual({ allowed: true });
    expect(limiter.consume('client', 1002)).toEqual({
      allowed: false,
      retryAfterSeconds: 10,
    });
    expect(limiter.consume('other-client', 1002)).toEqual({ allowed: true });
    expect(limiter.consume('client', 11_000)).toEqual({ allowed: true });
  });
});
