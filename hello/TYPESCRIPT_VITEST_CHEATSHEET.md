1. Narrowing refines a broad type after runtime checks, so each branch gets a safer, more specific type.
2. Common guards are `typeof`, `instanceof`, `in`, equality checks, truthiness checks, and custom `value is Type` predicates.
3. For discriminated unions, switch on a shared literal property such as `kind`; use `never` to check exhaustiveness.
4. A function type like `(input: string) => number` describes parameter and return types; `void` means its return value is ignored.
5. Use `?` only when a parameter may truly be omitted, use rest parameters for variable arguments, and prefer unions over unnecessary overloads.
6. Describe object shapes with `interface`, `type`, or an inline type; properties may be required, optional (`?`), or `readonly`.
7. TypeScript is structurally typed: a value is compatible when it has the required members, regardless of its declared name.
8. A union (`A | B`) accepts either shape, while an intersection (`A & B`) combines the requirements of both shapes.
9. Generics connect types across an API: `function identity<T>(value: T): T` preserves the caller's precise type.
10. Constrain generics only when needed, for example `<T extends { length: number }>` or `<K extends keyof T>`.
11. A file with a top-level `import` or `export` is a module with its own scope; prefer standard ES module syntax.
12. Export only the public API, use named imports for clarity, and use `import type`/`export type` for type-only dependencies.
13. `unknown` accepts any value but requires narrowing before use; `any` disables checking and lets unsafe operations spread.
14. Vitest discovers `.test.*` and `.spec.*` files; import `test`/`it` and `expect`, then run `pnpm test` or `pnpm vitest run`.
15. Use `describe` to group related tests, keep each test focused, and configure project-specific behavior in `vitest.config.*`.
