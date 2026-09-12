import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface ProductSeed {
  active: boolean;
  created_at: string;
  id: string;
  name: string;
  price_centimes: number;
  slug: string;
  store_id: string;
  updated_at: string;
}

const appRoot = resolve(import.meta.dirname, '..');
const sourcePath = resolve(appRoot, 'data/products.json');
const outputPath = resolve(appRoot, '.wrangler/tmp/seed-products.sql');
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  assertString(value, field);
  if (!isoDatePattern.test(value) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
}

const parseProducts = (input: unknown): ProductSeed[] => {
  if (!Array.isArray(input) || input.length !== 5) {
    throw new Error('products.json must contain exactly five products');
  }

  const products = input as Array<Record<string, unknown>>;
  const ids = new Set<string>();
  const slugs = new Set<string>();

  for (const [index, product] of products.entries()) {
    const prefix = `products[${index}]`;
    assertString(product.id, `${prefix}.id`);
    assertString(product.store_id, `${prefix}.store_id`);
    assertString(product.slug, `${prefix}.slug`);
    assertString(product.name, `${prefix}.name`);
    assertIsoDate(product.created_at, `${prefix}.created_at`);
    assertIsoDate(product.updated_at, `${prefix}.updated_at`);

    if (typeof product.active !== 'boolean') {
      throw new Error(`${prefix}.active must be a boolean`);
    }

    if (
      typeof product.price_centimes !== 'number' ||
      !Number.isInteger(product.price_centimes) ||
      product.price_centimes < 0
    ) {
      throw new Error(`${prefix}.price_centimes must be a non-negative integer`);
    }
    if (ids.has(product.id) || slugs.has(`${product.store_id}:${product.slug}`)) {
      throw new Error(`${prefix} duplicates an id or store slug`);
    }
    ids.add(product.id);
    slugs.add(`${product.store_id}:${product.slug}`);
  }

  return products as unknown as ProductSeed[];
};

const rawProducts: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
const products = parseProducts(rawProducts);
const firstProduct = products.at(0);

if (!firstProduct) {
  throw new Error('products.json must not be empty');
}

const storeId = firstProduct.store_id;
const timestamp = firstProduct.created_at;

if (products.some((product) => product.store_id !== storeId)) {
  throw new Error('All seed products must belong to the same store');
}

const values = products
  .map(
    (product) =>
      `(${[
        product.id,
        product.store_id,
        product.slug,
        product.name,
        product.price_centimes,
        product.active ? 1 : 0,
        product.created_at,
        product.updated_at,
      ]
        .map((value) => (typeof value === 'number' ? String(value) : quote(value)))
        .join(', ')})`,
  )
  .join(',\n  ');

const seedSql = `INSERT INTO settings (
  store_id, currency, locale, timezone, minimum_order_centimes, created_at, updated_at
) VALUES (
  ${quote(storeId)}, 'MAD', 'fr-MA', 'Africa/Casablanca', 0, ${quote(timestamp)}, ${quote(timestamp)}
) ON CONFLICT(store_id) DO UPDATE SET
  currency = excluded.currency,
  locale = excluded.locale,
  timezone = excluded.timezone,
  minimum_order_centimes = excluded.minimum_order_centimes,
  updated_at = excluded.updated_at;

INSERT INTO products (
  id, store_id, slug, name, price_centimes, active, created_at, updated_at
) VALUES
  ${values}
ON CONFLICT(id) DO UPDATE SET
  store_id = excluded.store_id,
  slug = excluded.slug,
  name = excluded.name,
  price_centimes = excluded.price_centimes,
  active = excluded.active,
  updated_at = excluded.updated_at;
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, seedSql, 'utf8');
console.log(`Prepared ${products.length} products from ${sourcePath}`);
