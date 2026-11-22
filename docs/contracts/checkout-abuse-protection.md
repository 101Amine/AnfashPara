# Checkout abuse protection

POST `/api/orders` checks the Cloudflare Rate Limiting binding before parsing the body or writing to D1. Staging uses namespace `10043`, with 10 attempts per client IP per 60 seconds. Invalid submissions and idempotent retries count too; a blocked retry can reuse its original idempotency key after waiting.

A rejected attempt returns private/no-store HTTP 429, `rate_limit_exceeded`, and `Retry-After: 60`. Missing configuration, a missing edge client address or a failed binding returns controlled HTTP 503, without processing the order. Only explicit `ENVIRONMENT=local` can use the in-memory development limiter. The key uses Cloudflare's `CF-Connecting-IP`, never user-supplied phone numbers, request bodies or X-Forwarded-For. No IP is stored in our D1 tables by this feature.

This is a practical burst deterrent, not a strict global quota or proof of a human customer. Cloudflare shares counters across Worker instances within a location, with eventual consistency; different locations have separate counters and bursts may exceed the configured threshold. Shared networks can also share the limit. Distributed abuse may require WAF rules or a verified challenge later.

The existing server-side validation, price snapshots, stock reservations, body size limit and idempotency remain necessary. Rate limiting does not replace them. Admin and signed courier/order webhook routes are unaffected.

Production launch must configure its own ORDER_RATE_LIMITER binding and a distinct namespace. Production configuration is deliberately not activated by this staging change.

Reference: [Cloudflare Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
