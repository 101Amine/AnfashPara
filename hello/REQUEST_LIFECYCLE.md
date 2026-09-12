1. A client sends an HTTP request to the Worker's URL.
2. Cloudflare routes it to a nearby location on its global network.
3. The route identifies which deployed Worker should handle the request.
4. Cloudflare loads or reuses a lightweight V8 isolate for the Worker.
5. The runtime invokes the `fetch(request, env, ctx)` handler.
6. `request` provides the URL, method, headers, and optional body.
7. `env` exposes configured bindings such as variables, KV, D1, and R2.
8. The handler can await storage operations or outbound subrequests.
9. The handler returns a standard Web API `Response` object.
10. Cloudflare sends the response to the client and exposes events through `wrangler tail`.
