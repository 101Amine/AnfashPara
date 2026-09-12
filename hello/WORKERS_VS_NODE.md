# Workers vs Node.js

Cloudflare Workers and Node.js both run JavaScript or TypeScript, but they use different execution models.

- A Worker starts from event handlers such as `fetch()` and `scheduled()`; a Node server usually starts a long-lived process that listens on a port.
- Workers run in lightweight V8 isolates distributed across Cloudflare's network; Node commonly runs as a process on a specific server or container.
- Workers use web-standard APIs such as `Request`, `Response`, `fetch`, and `URL`; Node also provides server and operating-system APIs.
- Worker instances are disposable, so mutable global memory cannot be treated as durable state.
- Workers receive configuration and Cloudflare resources through `env` bindings; Node applications commonly read `process.env` and use SDK credentials.
- Workers do not provide a normal persistent filesystem; durable data belongs in services such as D1, KV, R2, or Durable Objects.
- `ctx.waitUntil()` lets background work continue after an HTTP response; Node normally manages background work through its process or a separate job system.
- Cron Triggers invoke a Worker's `scheduled()` handler in UTC; Node applications need an external scheduler or an in-process cron library.
- Wrangler and workerd simulate the Workers runtime locally; Node applications run directly with the Node executable.
- Some Node packages work in Workers through compatibility support, but web-standard and Worker-native libraries are the safest default.

Secrets are encrypted bindings in production. Set them with `pnpm wrangler secret put NAME`; use an ignored `.dev.vars` file only for local values.
