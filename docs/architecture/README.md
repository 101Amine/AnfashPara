# Living architecture map

[`anfash-architecture.svg`](./anfash-architecture.svg) is the visual source of truth for the Anfash Para architecture.

## Update rule

Every merged module should update the SVG in the same pull request:

1. Add one stable `module-*` node for the new module.
2. Connect it to the modules it calls or depends on.
3. Use `data-status="planned"` while it is only designed or specified.
4. Change it to `implemented` once code and tests exist.
5. Use `live` for a surface that is actually deployed and reachable.

The diagram must describe the current system honestly. A contract is not an endpoint, a database table is not a workflow, and a protected route is not an admin application.
