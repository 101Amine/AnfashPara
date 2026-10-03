// apps/api/test/helpers/orderDatabase.ts
export async function resetOrderDatabase(database: D1Database): Promise<void> {
  const statements = [
    'DROP TABLE IF EXISTS outbox',
    'DROP TABLE IF EXISTS order_events',
    'DROP TABLE IF EXISTS order_items',
    'DROP TABLE IF EXISTS orders',
    'DROP TABLE IF EXISTS customers',
    'DROP TABLE IF EXISTS webhook_inbox',
    'DROP TABLE IF EXISTS products',
    `CREATE TABLE products (
      id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL, sku TEXT NOT NULL,
      slug TEXT NOT NULL, name TEXT NOT NULL, brand TEXT, cogs_centimes INTEGER NOT NULL,
      price_centimes INTEGER NOT NULL, compare_at_centimes INTEGER, active INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    'CREATE UNIQUE INDEX products_sku_unique ON products (sku)',
    'CREATE UNIQUE INDEX products_store_sku_unique ON products (store_id, sku)',
    `CREATE TABLE webhook_inbox (
      id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL, source TEXT NOT NULL,
      external_event_id TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT,
      error TEXT, payload_json TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX webhook_inbox_store_source_event_unique
      ON webhook_inbox (store_id, source, external_event_id)`,
    `CREATE TABLE customers (
      id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL, phone_e164 TEXT NOT NULL,
      name TEXT, city TEXT, orders_count INTEGER NOT NULL, delivered_count INTEGER NOT NULL,
      refused_count INTEGER NOT NULL, blacklisted INTEGER NOT NULL, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    'CREATE UNIQUE INDEX customers_store_phone_unique ON customers (store_id, phone_e164)',
    `CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL, external_id TEXT NOT NULL,
      order_number TEXT, customer_id TEXT NOT NULL REFERENCES customers(id), status TEXT NOT NULL,
      cod_amount_centimes INTEGER NOT NULL, shipping_fee_customer_centimes INTEGER NOT NULL,
      city TEXT, address TEXT, note TEXT, utm_source TEXT, utm_campaign TEXT, utm_content TEXT,
      placed_at TEXT NOT NULL, confirmed_at TEXT, shipped_at TEXT, closed_at TEXT,
      raw_payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    'CREATE UNIQUE INDEX orders_store_external_unique ON orders (store_id, external_id)',
    'CREATE UNIQUE INDEX orders_store_number_unique ON orders (store_id, order_number)',
    `CREATE TABLE order_items (
      id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sku TEXT NOT NULL REFERENCES products(sku), quantity INTEGER NOT NULL,
      unit_price_centimes INTEGER NOT NULL, unit_cogs_centimes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE order_events (
      id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT,
      payload_json TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE outbox (
      id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL, topic TEXT NOT NULL,
      aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT, last_error TEXT,
      processed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `INSERT INTO products VALUES
      ('bio-oil', 'para-main', 'BIO-OIL-125ML', 'bio-oil', 'Bio Oil', NULL,
       4200, 8900, NULL, 1, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'),
      ('mustela', 'para-main', 'MUSTELA-250ML', 'mustela', 'Mustela', NULL,
       5100, 10900, NULL, 1, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`,
  ];

  for (const statement of statements) await database.prepare(statement).run();
}

export async function rowCount(database: D1Database, table: string): Promise<number> {
  const result = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return result?.count ?? 0;
}
