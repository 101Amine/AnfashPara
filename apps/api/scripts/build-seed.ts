// apps/api/scripts/build-seed.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ORDER_STATUSES, type OrderStatus } from '../src/db/schema';

type SqlValue = null | number | string;

interface ProductSeed {
  active: boolean;
  brand: string;
  cogs_centimes: number;
  compare_at_centimes: number | null;
  created_at: string;
  id: string;
  name: string;
  price_centimes: number;
  sku: string;
  slug: string;
  store_id: string;
  updated_at: string;
}

interface CustomerSeed {
  blacklisted: boolean;
  city: string;
  id: string;
  name: string;
  phone: string;
}

interface OrderSeed {
  customerId: string;
  externalId: string;
  id: string;
  number: string;
  placedAt: string;
  status: OrderStatus;
}

interface ShipmentSeed {
  courierStatus: string;
  id: string;
  orderId: string;
  status: 'delivered' | 'in_transit' | 'refused' | 'returned';
  trackingNumber: string;
}

const appRoot = resolve(import.meta.dirname, '..');
const sourcePath = resolve(appRoot, 'data/products.json');
const outputPath = resolve(appRoot, '.wrangler/tmp/seed.sql');
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STORE_ID = 'para-main';
const BASE_TIMESTAMP = '2026-09-12T08:00:00.000Z';

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlValue = (value: SqlValue): string => {
  if (value === null) return 'NULL';
  return typeof value === 'number' ? String(value) : quote(value);
};

const insertSql = (
  table: string,
  columns: readonly string[],
  rows: readonly SqlValue[][],
): string => {
  if (rows.length === 0) throw new Error(`${table} requires at least one seed row`);
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${rows
    .map((row) => `  (${row.map(sqlValue).join(', ')})`)
    .join(',\n')};`;
};

const uuidV7 = (sequence: number): string => {
  const suffix = sequence.toString(16).padStart(12, '0');
  const versionGroup = `7${sequence.toString(16).padStart(3, '0')}`;
  return `01991a00-0000-${versionGroup}-8000-${suffix}`;
};

const timestampAt = (hour: number): string =>
  new Date(Date.UTC(2026, 8, 12 + Math.floor(hour / 24), hour % 24)).toISOString();

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertInteger(
  value: unknown,
  field: string,
  nullable = false,
): asserts value is number | null {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer${nullable ? ' or null' : ''}`);
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

  const ids = new Set<string>();
  const skus = new Set<string>();
  const slugs = new Set<string>();

  for (const [index, value] of input.entries()) {
    if (typeof value !== 'object' || value === null)
      throw new Error(`products[${index}] must be an object`);
    const product = value as Record<string, unknown>;
    const prefix = `products[${index}]`;
    assertString(product.id, `${prefix}.id`);
    assertString(product.store_id, `${prefix}.store_id`);
    assertString(product.sku, `${prefix}.sku`);
    assertString(product.slug, `${prefix}.slug`);
    assertString(product.name, `${prefix}.name`);
    assertString(product.brand, `${prefix}.brand`);
    assertInteger(product.cogs_centimes, `${prefix}.cogs_centimes`);
    assertInteger(product.price_centimes, `${prefix}.price_centimes`);
    assertInteger(product.compare_at_centimes, `${prefix}.compare_at_centimes`, true);
    assertIsoDate(product.created_at, `${prefix}.created_at`);
    assertIsoDate(product.updated_at, `${prefix}.updated_at`);
    if (typeof product.active !== 'boolean') throw new Error(`${prefix}.active must be boolean`);
    if (product.store_id !== STORE_ID) throw new Error(`${prefix}.store_id must be ${STORE_ID}`);
    if (ids.has(product.id) || skus.has(product.sku) || slugs.has(product.slug)) {
      throw new Error(`${prefix} duplicates an id, SKU, or slug`);
    }
    ids.add(product.id);
    skus.add(product.sku);
    slugs.add(product.slug);
  }

  return input as ProductSeed[];
};

const rawProducts: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
const products = parseProducts(rawProducts);

const customers: CustomerSeed[] = [
  ['Amina El Idrissi', '+212612345671', 'Casablanca', false],
  ['Sara Bennani', '+212612345672', 'Rabat', false],
  ['Khadija Alaoui', '+212712345673', 'Marrakech', false],
  ['Imane Tazi', '+212612345674', 'Fès', false],
  ['Nadia Amrani', '+212712345675', 'Tanger', false],
  ['Yasmine Chraibi', '+212612345676', 'Agadir', false],
  ['Salma Berrada', '+212712345677', 'Meknès', false],
  ['Lina El Fassi', '+212612345678', 'Casablanca', true],
].map(([name, phone, city, blacklisted], index) => ({
  blacklisted: Boolean(blacklisted),
  city: String(city),
  id: uuidV7(index + 1),
  name: String(name),
  phone: String(phone),
}));

const seededStatuses: OrderStatus[] = [
  ...ORDER_STATUSES,
  'NEW',
  'CONFIRMING',
  'CONFIRMED',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'REFUSED',
  'RETURNED',
  'SETTLED',
];

const orders: OrderSeed[] = seededStatuses.map((status, index) => ({
  customerId: customers[index % customers.length]!.id,
  externalId: `seed-external-${String(index + 1).padStart(3, '0')}`,
  id: uuidV7(20 + index),
  number: `PARA-${String(index + 1).padStart(4, '0')}`,
  placedAt: timestampAt(index),
  status,
}));

const shipmentOrderIndexes = [6, 7, 8, 9, 10, 15] as const;
const shipmentStatusByOrder = {
  DELIVERED: 'delivered',
  REFUSED: 'refused',
  RETURNED: 'returned',
  SETTLED: 'delivered',
  SHIPPED: 'in_transit',
} as const;

const shipments: ShipmentSeed[] = shipmentOrderIndexes.map((orderIndex, index) => {
  const order = orders[orderIndex]!;
  const status = shipmentStatusByOrder[order.status as keyof typeof shipmentStatusByOrder];
  return {
    courierStatus: status === 'in_transit' ? 'En cours' : status === 'delivered' ? 'Livré' : status,
    id: uuidV7(90 + index),
    orderId: order.id,
    status,
    trackingNumber: `SDT-SEED-${String(index + 1).padStart(5, '0')}`,
  };
});

const customerRows = customers.map((customer) => {
  const customerOrders = orders.filter((order) => order.customerId === customer.id);
  return [
    customer.id,
    STORE_ID,
    customer.phone,
    customer.name,
    customer.city,
    customerOrders.length,
    customerOrders.filter((order) => order.status === 'DELIVERED' || order.status === 'SETTLED')
      .length,
    customerOrders.filter((order) => order.status === 'REFUSED' || order.status === 'RETURNED')
      .length,
    customer.blacklisted ? 1 : 0,
    customer.blacklisted ? 'Seeded manual review flag' : null,
    BASE_TIMESTAMP,
    BASE_TIMESTAMP,
  ];
});

const orderRows = orders.map((order, index) => {
  const product = products[index % products.length]!;
  const progressed = !['NEW', 'CONFIRMING', 'NO_ANSWER', 'CANCELLED'].includes(order.status);
  const shipped = ['SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED'].includes(order.status);
  const closed = ['CANCELLED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED'].includes(
    order.status,
  );
  return [
    order.id,
    STORE_ID,
    order.externalId,
    order.number,
    order.customerId,
    order.status,
    product.price_centimes + 3500,
    3500,
    customers[index % customers.length]!.city,
    `${index + 1}, rue de la seed`,
    index % 4 === 0 ? 'Appeler avant livraison' : null,
    index % 2 === 0 ? 'meta' : 'ig_organic',
    'launch-week',
    `creative-${(index % 4) + 1}`,
    order.placedAt,
    progressed ? timestampAt(index + 1) : null,
    shipped ? timestampAt(index + 2) : null,
    closed ? timestampAt(index + 3) : null,
    JSON.stringify({ externalId: order.externalId, source: 'seed' }),
    order.placedAt,
    timestampAt(index + 3),
  ];
});

const orderItemRows = orders.map((order, index) => {
  const product = products[index % products.length]!;
  return [
    uuidV7(50 + index),
    STORE_ID,
    order.id,
    product.sku,
    index % 5 === 0 ? 2 : 1,
    product.price_centimes,
    product.cogs_centimes,
    order.placedAt,
  ];
});

const inventoryMovementRows: SqlValue[][] = products.map((product, index) => [
  uuidV7(200 + index),
  STORE_ID,
  product.sku,
  20 + index * 5,
  'purchase',
  'SEED-PO-001',
  BASE_TIMESTAMP,
]);

for (const [index, order] of orders.entries()) {
  if (!['SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED'].includes(order.status)) {
    continue;
  }

  const orderItem = orderItemRows[index]!;
  const sku = String(orderItem[3]);
  const quantity = Number(orderItem[4]);
  inventoryMovementRows.push([
    uuidV7(210 + index),
    STORE_ID,
    sku,
    -quantity,
    'shipped',
    `order:${order.id}:shipped`,
    timestampAt(index + 2),
  ]);

  if (order.status === 'RETURNED') {
    inventoryMovementRows.push([
      uuidV7(240 + index),
      STORE_ID,
      sku,
      quantity,
      'returned',
      `order:${order.id}:returned`,
      timestampAt(index + 3),
    ]);
  }
}

const orderEventRows = orders.map((order, index) => [
  uuidV7(120 + index),
  STORE_ID,
  order.id,
  null,
  order.status,
  'system:seed',
  'seed_fixture',
  JSON.stringify({ fixture: true }),
  timestampAt(index + 1),
]);

const shipmentRows = shipments.map((shipment, index) => [
  shipment.id,
  STORE_ID,
  shipment.orderId,
  'sendit',
  shipment.trackingNumber,
  shipment.courierStatus,
  shipment.status,
  shipment.status === 'in_transit' ? null : 3500,
  shipment.status === 'refused' || shipment.status === 'returned' ? 1500 : null,
  `https://example.invalid/labels/${shipment.trackingNumber}.pdf`,
  timestampAt(30 + index),
  timestampAt(31 + index),
]);

const settlementId = uuidV7(160);
const settlementSourceShipments = [shipments[1]!, shipments[4]!, shipments[5]!];
const settlementRows = settlementSourceShipments.map((shipment, index) => {
  const order = orders.find((candidate) => candidate.id === shipment.orderId)!;
  const product = products[orders.indexOf(order) % products.length]!;
  const cod = product.price_centimes + 3500;
  const expectedFee = 3500;
  const fee = index === 1 ? 4200 : expectedFee;
  return [
    uuidV7(161 + index),
    STORE_ID,
    settlementId,
    shipment.trackingNumber,
    cod,
    fee,
    cod - fee,
    expectedFee,
    index === 1 ? 'fee_mismatch' : 'matched',
    shipment.id,
    timestampAt(48),
  ];
});
const settlementAmount = settlementRows.reduce((sum, row) => sum + Number(row[6]), 0);

const deleteSql = [
  'DELETE FROM settlement_lines;',
  'DELETE FROM courier_settlements;',
  'DELETE FROM shipment_events;',
  'DELETE FROM shipments;',
  'DELETE FROM confirmation_attempts;',
  'DELETE FROM order_events;',
  'DELETE FROM order_items;',
  'DELETE FROM outbox;',
  'DELETE FROM webhook_inbox;',
  'DELETE FROM inventory_movements;',
  'DELETE FROM orders;',
  'DELETE FROM customers;',
  'DELETE FROM ad_spend_daily;',
].join('\n');

const productRows = products.map((product) => [
  product.id,
  product.store_id,
  product.sku,
  product.slug,
  product.name,
  product.brand,
  product.cogs_centimes,
  product.price_centimes,
  product.compare_at_centimes,
  product.active ? 1 : 0,
  product.created_at,
  product.updated_at,
]);

const sql = [
  deleteSql,
  `INSERT INTO settings (store_id, currency, locale, timezone, minimum_order_centimes, created_at, updated_at)
VALUES (${quote(STORE_ID)}, 'MAD', 'fr-MA', 'Africa/Casablanca', 35000, ${quote(BASE_TIMESTAMP)}, ${quote(BASE_TIMESTAMP)})
ON CONFLICT(store_id) DO UPDATE SET minimum_order_centimes = excluded.minimum_order_centimes, updated_at = excluded.updated_at;`,
  `${insertSql(
    'products',
    [
      'id',
      'store_id',
      'sku',
      'slug',
      'name',
      'brand',
      'cogs_centimes',
      'price_centimes',
      'compare_at_centimes',
      'active',
      'created_at',
      'updated_at',
    ],
    productRows,
  ).slice(0, -1)}
ON CONFLICT(id) DO UPDATE SET sku = excluded.sku, slug = excluded.slug, name = excluded.name, brand = excluded.brand, cogs_centimes = excluded.cogs_centimes, price_centimes = excluded.price_centimes, compare_at_centimes = excluded.compare_at_centimes, active = excluded.active, updated_at = excluded.updated_at;`,
  insertSql(
    'customers',
    [
      'id',
      'store_id',
      'phone_e164',
      'name',
      'city',
      'orders_count',
      'delivered_count',
      'refused_count',
      'blacklisted',
      'notes',
      'created_at',
      'updated_at',
    ],
    customerRows,
  ),
  insertSql(
    'orders',
    [
      'id',
      'store_id',
      'external_id',
      'order_number',
      'customer_id',
      'status',
      'cod_amount_centimes',
      'shipping_fee_customer_centimes',
      'city',
      'address',
      'note',
      'utm_source',
      'utm_campaign',
      'utm_content',
      'placed_at',
      'confirmed_at',
      'shipped_at',
      'closed_at',
      'raw_payload_json',
      'created_at',
      'updated_at',
    ],
    orderRows,
  ),
  insertSql(
    'order_items',
    [
      'id',
      'store_id',
      'order_id',
      'sku',
      'quantity',
      'unit_price_centimes',
      'unit_cogs_centimes',
      'created_at',
    ],
    orderItemRows,
  ),
  insertSql(
    'order_events',
    [
      'id',
      'store_id',
      'order_id',
      'from_status',
      'to_status',
      'actor',
      'reason',
      'payload_json',
      'created_at',
    ],
    orderEventRows,
  ),
  insertSql(
    'confirmation_attempts',
    ['id', 'store_id', 'order_id', 'channel', 'outcome', 'attempted_by', 'created_at'],
    [
      [uuidV7(150), STORE_ID, orders[1]!.id, 'whatsapp', 'callback', 'wife', timestampAt(4)],
      [uuidV7(151), STORE_ID, orders[2]!.id, 'call', 'no_answer', 'becha', timestampAt(5)],
      [uuidV7(152), STORE_ID, orders[3]!.id, 'whatsapp', 'confirmed', 'wife', timestampAt(6)],
      [uuidV7(153), STORE_ID, orders[4]!.id, 'call', 'cancelled', 'becha', timestampAt(7)],
    ],
  ),
  insertSql(
    'shipments',
    [
      'id',
      'store_id',
      'order_id',
      'courier',
      'tracking_number',
      'courier_status',
      'status_normalized',
      'delivery_fee_centimes',
      'return_fee_centimes',
      'label_url',
      'created_at',
      'updated_at',
    ],
    shipmentRows,
  ),
  insertSql(
    'shipment_events',
    [
      'id',
      'store_id',
      'shipment_id',
      'courier_status',
      'status_normalized',
      'occurred_at',
      'payload_json',
    ],
    shipments.map((shipment, index) => [
      uuidV7(170 + index),
      STORE_ID,
      shipment.id,
      shipment.courierStatus,
      shipment.status,
      timestampAt(36 + index),
      JSON.stringify({ trackingNumber: shipment.trackingNumber }),
    ]),
  ),
  insertSql(
    'courier_settlements',
    [
      'id',
      'store_id',
      'courier',
      'statement_reference',
      'period_start',
      'period_end',
      'amount_paid_centimes',
      'imported_at',
      'source_file',
    ],
    [
      [
        settlementId,
        STORE_ID,
        'sendit',
        'SEED-STATEMENT-001',
        '2026-09-01',
        '2026-09-12',
        settlementAmount,
        timestampAt(48),
        'seed-settlement.csv',
      ],
    ],
  ),
  insertSql(
    'settlement_lines',
    [
      'id',
      'store_id',
      'settlement_id',
      'tracking_number',
      'cod_collected_centimes',
      'fee_centimes',
      'net_centimes',
      'expected_fee_centimes',
      'line_status',
      'shipment_id',
      'created_at',
    ],
    settlementRows,
  ),
  insertSql(
    'outbox',
    [
      'id',
      'store_id',
      'topic',
      'aggregate_type',
      'aggregate_id',
      'payload_json',
      'status',
      'attempts',
      'next_attempt_at',
      'last_error',
      'processed_at',
      'created_at',
      'updated_at',
    ],
    [
      [
        uuidV7(180),
        STORE_ID,
        'order.confirmed',
        'order',
        orders[3]!.id,
        JSON.stringify({ orderId: orders[3]!.id }),
        'done',
        1,
        null,
        null,
        timestampAt(10),
        timestampAt(8),
        timestampAt(10),
      ],
      [
        uuidV7(181),
        STORE_ID,
        'shipment.status',
        'shipment',
        shipments[2]!.id,
        JSON.stringify({ shipmentId: shipments[2]!.id }),
        'failed',
        3,
        timestampAt(52),
        'Seeded provider timeout',
        null,
        timestampAt(40),
        timestampAt(51),
      ],
    ],
  ),
  insertSql(
    'webhook_inbox',
    [
      'id',
      'store_id',
      'source',
      'external_event_id',
      'received_at',
      'processed_at',
      'error',
      'payload_json',
    ],
    [
      [
        uuidV7(190),
        STORE_ID,
        'youcan',
        'seed-event-001',
        timestampAt(1),
        timestampAt(1),
        null,
        JSON.stringify({ event: 'order.created' }),
      ],
      [
        uuidV7(191),
        STORE_ID,
        'sendit',
        'seed-event-002',
        timestampAt(2),
        null,
        null,
        JSON.stringify({ event: 'shipment.updated' }),
      ],
    ],
  ),
  insertSql(
    'inventory_movements',
    ['id', 'store_id', 'sku', 'quantity', 'reason', 'reference', 'created_at'],
    inventoryMovementRows,
  ),
  insertSql(
    'ad_spend_daily',
    [
      'store_id',
      'day',
      'platform',
      'campaign',
      'adset',
      'ad_content',
      'spend_centimes',
      'created_at',
      'updated_at',
    ],
    [
      [
        STORE_ID,
        '2026-09-11',
        'meta',
        'launch-week',
        'broad-casa',
        'creative-1',
        12500,
        BASE_TIMESTAMP,
        BASE_TIMESTAMP,
      ],
      [
        STORE_ID,
        '2026-09-12',
        'tiktok',
        'launch-week',
        'beauty-ma',
        'creative-2',
        9800,
        BASE_TIMESTAMP,
        BASE_TIMESTAMP,
      ],
    ],
  ),
  '',
].join('\n\n');

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, sql, 'utf8');
console.log(
  `Prepared seed: ${products.length} products, ${customers.length} customers, ${orders.length} orders, ${shipments.length} shipments`,
);
