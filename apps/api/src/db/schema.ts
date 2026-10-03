// apps/api/src/db/schema.ts
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { SHIPMENT_STATUSES } from '../contracts/fulfillment';

export { SHIPMENT_STATUSES } from '../contracts/fulfillment';

export const ORDER_STATUSES = [
  'NEW',
  'CONFIRMING',
  'NO_ANSWER',
  'CONFIRMED',
  'CANCELLED',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'REFUSED',
  'RETURNED',
  'SETTLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const INVENTORY_REASONS = [
  'purchase',
  'shipped',
  'returned',
  'damaged',
  'adjustment',
] as const;
export const CONFIRMATION_CHANNELS = ['call', 'whatsapp'] as const;
export const CONFIRMATION_OUTCOMES = [
  'confirmed',
  'no_answer',
  'cancelled',
  'callback',
  'wrong_number',
] as const;
export const OUTBOX_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;
export const SETTLEMENT_LINE_STATUSES = ['matched', 'fee_mismatch', 'unmatched'] as const;

const isoDateCheck = (column: AnySQLiteColumn) => sql`${column} GLOB '????-??-??T??:??:??.???Z'`;
const calendarDateCheck = (column: AnySQLiteColumn) => sql`${column} GLOB '????-??-??'`;
const uuidV7Check = (column: AnySQLiteColumn) =>
  sql`length(${column}) = 36 AND substr(${column}, 9, 1) = '-' AND substr(${column}, 14, 1) = '-' AND substr(${column}, 15, 1) = '7' AND substr(${column}, 19, 1) = '-' AND lower(substr(${column}, 20, 1)) GLOB '[89ab]' AND substr(${column}, 24, 1) = '-'`;
const nonNegativeIntegerCheck = (column: AnySQLiteColumn) =>
  sql`typeof(${column}) = 'integer' AND ${column} >= 0`;
const positiveIntegerCheck = (column: AnySQLiteColumn) =>
  sql`typeof(${column}) = 'integer' AND ${column} > 0`;
const jsonCheck = (column: AnySQLiteColumn) => sql`json_valid(${column})`;

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    sku: text('sku').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    brand: text('brand'),
    cogsCentimes: integer('cogs_centimes').notNull().default(0),
    priceCentimes: integer('price_centimes').notNull(),
    compareAtCentimes: integer('compare_at_centimes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('products_sku_unique').on(table.sku),
    uniqueIndex('products_store_sku_unique').on(table.storeId, table.sku),
    uniqueIndex('products_store_slug_unique').on(table.storeId, table.slug),
    index('products_store_active_index').on(table.storeId, table.active),
    check('products_sku_not_empty', sql`length(trim(${table.sku})) > 0`),
    check('products_cogs_centimes_valid', nonNegativeIntegerCheck(table.cogsCentimes)),
    check('products_price_centimes_valid', nonNegativeIntegerCheck(table.priceCentimes)),
    check(
      'products_compare_at_centimes_valid',
      sql`${table.compareAtCentimes} IS NULL OR (${nonNegativeIntegerCheck(table.compareAtCentimes)})`,
    ),
    check('products_active_boolean', sql`${table.active} IN (0, 1)`),
    check('products_created_at_iso', isoDateCheck(table.createdAt)),
    check('products_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);

export const settings = sqliteTable(
  'settings',
  {
    storeId: text('store_id').primaryKey(),
    currency: text('currency').notNull().default('MAD'),
    locale: text('locale').notNull().default('fr-MA'),
    timezone: text('timezone').notNull().default('Africa/Casablanca'),
    minimumOrderCentimes: integer('minimum_order_centimes').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('settings_currency_iso_4217', sql`length(${table.currency}) = 3`),
    check('settings_minimum_order_valid', nonNegativeIntegerCheck(table.minimumOrderCentimes)),
    check('settings_created_at_iso', isoDateCheck(table.createdAt)),
    check('settings_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);

export const inventoryMovements = sqliteTable(
  'inventory_movements',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    sku: text('sku')
      .notNull()
      .references(() => products.sku),
    quantity: integer('quantity').notNull(),
    reason: text('reason', { enum: INVENTORY_REASONS }).notNull(),
    reference: text('reference'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('inventory_store_sku_created_index').on(table.storeId, table.sku, table.createdAt),
    uniqueIndex('inventory_store_sku_reason_reference_unique').on(
      table.storeId,
      table.sku,
      table.reason,
      table.reference,
    ),
    check('inventory_id_uuid_v7', uuidV7Check(table.id)),
    check(
      'inventory_quantity_non_zero',
      sql`typeof(${table.quantity}) = 'integer' AND ${table.quantity} <> 0`,
    ),
    check(
      'inventory_reason_valid',
      sql`${table.reason} IN ('purchase', 'shipped', 'returned', 'damaged', 'adjustment')`,
    ),
    check('inventory_created_at_iso', isoDateCheck(table.createdAt)),
  ],
);

export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    phoneE164: text('phone_e164').notNull(),
    name: text('name'),
    city: text('city'),
    ordersCount: integer('orders_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    refusedCount: integer('refused_count').notNull().default(0),
    blacklisted: integer('blacklisted', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('customers_store_phone_unique').on(table.storeId, table.phoneE164),
    index('customers_store_blacklisted_index').on(table.storeId, table.blacklisted),
    check('customers_id_uuid_v7', uuidV7Check(table.id)),
    check('customers_phone_e164_ma', sql`${table.phoneE164} GLOB '+212[67]????????'`),
    check('customers_orders_count_valid', nonNegativeIntegerCheck(table.ordersCount)),
    check('customers_delivered_count_valid', nonNegativeIntegerCheck(table.deliveredCount)),
    check('customers_refused_count_valid', nonNegativeIntegerCheck(table.refusedCount)),
    check('customers_blacklisted_boolean', sql`${table.blacklisted} IN (0, 1)`),
    check('customers_created_at_iso', isoDateCheck(table.createdAt)),
    check('customers_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    externalId: text('external_id').notNull(),
    orderNumber: text('order_number'),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('NEW'),
    codAmountCentimes: integer('cod_amount_centimes').notNull(),
    shippingFeeCustomerCentimes: integer('shipping_fee_customer_centimes').notNull().default(0),
    city: text('city'),
    address: text('address'),
    note: text('note'),
    utmSource: text('utm_source'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    placedAt: text('placed_at').notNull(),
    confirmedAt: text('confirmed_at'),
    shippedAt: text('shipped_at'),
    closedAt: text('closed_at'),
    rawPayloadJson: text('raw_payload_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('orders_store_external_unique').on(table.storeId, table.externalId),
    uniqueIndex('orders_store_number_unique').on(table.storeId, table.orderNumber),
    index('orders_store_status_placed_index').on(table.storeId, table.status, table.placedAt),
    index('orders_customer_placed_index').on(table.customerId, table.placedAt),
    check('orders_id_uuid_v7', uuidV7Check(table.id)),
    check(
      'orders_status_valid',
      sql`${table.status} IN ('NEW', 'CONFIRMING', 'NO_ANSWER', 'CONFIRMED', 'CANCELLED', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED')`,
    ),
    check('orders_cod_amount_valid', nonNegativeIntegerCheck(table.codAmountCentimes)),
    check(
      'orders_shipping_fee_customer_valid',
      nonNegativeIntegerCheck(table.shippingFeeCustomerCentimes),
    ),
    check('orders_placed_at_iso', isoDateCheck(table.placedAt)),
    check(
      'orders_confirmed_at_iso',
      sql`${table.confirmedAt} IS NULL OR (${isoDateCheck(table.confirmedAt)})`,
    ),
    check(
      'orders_shipped_at_iso',
      sql`${table.shippedAt} IS NULL OR (${isoDateCheck(table.shippedAt)})`,
    ),
    check(
      'orders_closed_at_iso',
      sql`${table.closedAt} IS NULL OR (${isoDateCheck(table.closedAt)})`,
    ),
    check('orders_raw_payload_json', jsonCheck(table.rawPayloadJson)),
    check('orders_created_at_iso', isoDateCheck(table.createdAt)),
    check('orders_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    sku: text('sku')
      .notNull()
      .references(() => products.sku),
    quantity: integer('quantity').notNull(),
    unitPriceCentimes: integer('unit_price_centimes').notNull(),
    unitCogsCentimes: integer('unit_cogs_centimes').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('order_items_order_index').on(table.orderId),
    index('order_items_store_sku_index').on(table.storeId, table.sku),
    check('order_items_id_uuid_v7', uuidV7Check(table.id)),
    check('order_items_quantity_valid', positiveIntegerCheck(table.quantity)),
    check('order_items_unit_price_valid', nonNegativeIntegerCheck(table.unitPriceCentimes)),
    check('order_items_unit_cogs_valid', nonNegativeIntegerCheck(table.unitCogsCentimes)),
    check('order_items_created_at_iso', isoDateCheck(table.createdAt)),
  ],
);

export const orderEvents = sqliteTable(
  'order_events',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status', { enum: ORDER_STATUSES }),
    toStatus: text('to_status', { enum: ORDER_STATUSES }).notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    payloadJson: text('payload_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('order_events_order_created_index').on(table.orderId, table.createdAt),
    check('order_events_id_uuid_v7', uuidV7Check(table.id)),
    check(
      'order_events_from_status_valid',
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('NEW', 'CONFIRMING', 'NO_ANSWER', 'CONFIRMED', 'CANCELLED', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED')`,
    ),
    check(
      'order_events_to_status_valid',
      sql`${table.toStatus} IN ('NEW', 'CONFIRMING', 'NO_ANSWER', 'CONFIRMED', 'CANCELLED', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED')`,
    ),
    check(
      'order_events_payload_json',
      sql`${table.payloadJson} IS NULL OR (${jsonCheck(table.payloadJson)})`,
    ),
    check('order_events_created_at_iso', isoDateCheck(table.createdAt)),
  ],
);

export const confirmationAttempts = sqliteTable(
  'confirmation_attempts',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CONFIRMATION_CHANNELS }).notNull(),
    outcome: text('outcome', { enum: CONFIRMATION_OUTCOMES }).notNull(),
    attemptedBy: text('attempted_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('confirmation_attempts_order_created_index').on(table.orderId, table.createdAt),
    check('confirmation_attempts_id_uuid_v7', uuidV7Check(table.id)),
    check('confirmation_attempts_channel_valid', sql`${table.channel} IN ('call', 'whatsapp')`),
    check(
      'confirmation_attempts_outcome_valid',
      sql`${table.outcome} IN ('confirmed', 'no_answer', 'cancelled', 'callback', 'wrong_number')`,
    ),
    check('confirmation_attempts_created_at_iso', isoDateCheck(table.createdAt)),
  ],
);

export const shipments = sqliteTable(
  'shipments',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    courier: text('courier').notNull(),
    trackingNumber: text('tracking_number').notNull(),
    courierStatus: text('courier_status'),
    statusNormalized: text('status_normalized', { enum: SHIPMENT_STATUSES }).notNull(),
    deliveryFeeCentimes: integer('delivery_fee_centimes'),
    returnFeeCentimes: integer('return_fee_centimes'),
    labelUrl: text('label_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('shipments_store_tracking_unique').on(table.storeId, table.trackingNumber),
    uniqueIndex('shipments_store_order_unique').on(table.storeId, table.orderId),
    index('shipments_store_status_index').on(table.storeId, table.statusNormalized),
    check('shipments_id_uuid_v7', uuidV7Check(table.id)),
    check(
      'shipments_status_normalized_valid',
      sql`${table.statusNormalized} IN ('created', 'picked', 'in_transit', 'out_for_delivery', 'delivered', 'refused', 'returned', 'lost')`,
    ),
    check(
      'shipments_delivery_fee_valid',
      sql`${table.deliveryFeeCentimes} IS NULL OR (${nonNegativeIntegerCheck(table.deliveryFeeCentimes)})`,
    ),
    check(
      'shipments_return_fee_valid',
      sql`${table.returnFeeCentimes} IS NULL OR (${nonNegativeIntegerCheck(table.returnFeeCentimes)})`,
    ),
    check('shipments_created_at_iso', isoDateCheck(table.createdAt)),
    check('shipments_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);

export const shipmentEvents = sqliteTable(
  'shipment_events',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    shipmentId: text('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    courierStatus: text('courier_status').notNull(),
    statusNormalized: text('status_normalized', { enum: SHIPMENT_STATUSES }).notNull(),
    occurredAt: text('occurred_at').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [
    index('shipment_events_shipment_occurred_index').on(table.shipmentId, table.occurredAt),
    check('shipment_events_id_uuid_v7', uuidV7Check(table.id)),
    check(
      'shipment_events_status_normalized_valid',
      sql`${table.statusNormalized} IN ('created', 'picked', 'in_transit', 'out_for_delivery', 'delivered', 'refused', 'returned', 'lost')`,
    ),
    check('shipment_events_occurred_at_iso', isoDateCheck(table.occurredAt)),
    check('shipment_events_payload_json', jsonCheck(table.payloadJson)),
  ],
);

export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    topic: text('topic').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    lastError: text('last_error'),
    processedAt: text('processed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('outbox_dispatch_index').on(table.storeId, table.status, table.nextAttemptAt),
    index('outbox_aggregate_index').on(table.aggregateType, table.aggregateId),
    check('outbox_id_uuid_v7', uuidV7Check(table.id)),
    check('outbox_payload_json', jsonCheck(table.payloadJson)),
    check(
      'outbox_status_valid',
      sql`${table.status} IN ('pending', 'processing', 'done', 'failed')`,
    ),
    check('outbox_attempts_valid', nonNegativeIntegerCheck(table.attempts)),
    check(
      'outbox_next_attempt_at_iso',
      sql`${table.nextAttemptAt} IS NULL OR (${isoDateCheck(table.nextAttemptAt)})`,
    ),
    check(
      'outbox_processed_at_iso',
      sql`${table.processedAt} IS NULL OR (${isoDateCheck(table.processedAt)})`,
    ),
    check('outbox_created_at_iso', isoDateCheck(table.createdAt)),
    check('outbox_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);

export const webhookInbox = sqliteTable(
  'webhook_inbox',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    source: text('source').notNull(),
    externalEventId: text('external_event_id').notNull(),
    receivedAt: text('received_at').notNull(),
    processedAt: text('processed_at'),
    error: text('error'),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [
    uniqueIndex('webhook_inbox_store_source_event_unique').on(
      table.storeId,
      table.source,
      table.externalEventId,
    ),
    index('webhook_inbox_unprocessed_index').on(table.storeId, table.processedAt, table.receivedAt),
    check('webhook_inbox_id_uuid_v7', uuidV7Check(table.id)),
    check('webhook_inbox_received_at_iso', isoDateCheck(table.receivedAt)),
    check(
      'webhook_inbox_processed_at_iso',
      sql`${table.processedAt} IS NULL OR (${isoDateCheck(table.processedAt)})`,
    ),
    check('webhook_inbox_payload_json', jsonCheck(table.payloadJson)),
  ],
);

export const courierSettlements = sqliteTable(
  'courier_settlements',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    courier: text('courier').notNull(),
    statementReference: text('statement_reference').notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    amountPaidCentimes: integer('amount_paid_centimes').notNull(),
    importedAt: text('imported_at').notNull(),
    sourceFile: text('source_file'),
    contentHash: text('content_hash'),
    reportJson: text('report_json'),
    importedBy: text('imported_by'),
  },
  (table) => [
    uniqueIndex('courier_settlements_store_statement_unique').on(
      table.storeId,
      table.courier,
      table.statementReference,
    ),
    index('courier_settlements_store_imported_index').on(table.storeId, table.importedAt),
    check('courier_settlements_id_uuid_v7', uuidV7Check(table.id)),
    check('courier_settlements_period_start_date', calendarDateCheck(table.periodStart)),
    check('courier_settlements_period_end_date', calendarDateCheck(table.periodEnd)),
    check('courier_settlements_period_order', sql`${table.periodStart} <= ${table.periodEnd}`),
    check(
      'courier_settlements_amount_paid_valid',
      nonNegativeIntegerCheck(table.amountPaidCentimes),
    ),
    check('courier_settlements_imported_at_iso', isoDateCheck(table.importedAt)),
  ],
);

export const settlementLines = sqliteTable(
  'settlement_lines',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    settlementId: text('settlement_id')
      .notNull()
      .references(() => courierSettlements.id, { onDelete: 'cascade' }),
    trackingNumber: text('tracking_number').notNull(),
    codCollectedCentimes: integer('cod_collected_centimes').notNull(),
    feeCentimes: integer('fee_centimes').notNull(),
    netCentimes: integer('net_centimes').notNull(),
    expectedFeeCentimes: integer('expected_fee_centimes').notNull(),
    lineStatus: text('line_status', { enum: SETTLEMENT_LINE_STATUSES }).notNull(),
    shipmentId: text('shipment_id').references(() => shipments.id),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('settlement_lines_settlement_index').on(table.settlementId),
    index('settlement_lines_tracking_index').on(table.storeId, table.trackingNumber),
    index('settlement_lines_shipment_index').on(table.shipmentId),
    check('settlement_lines_id_uuid_v7', uuidV7Check(table.id)),
    check(
      'settlement_lines_cod_collected_valid',
      nonNegativeIntegerCheck(table.codCollectedCentimes),
    ),
    check('settlement_lines_fee_valid', nonNegativeIntegerCheck(table.feeCentimes)),
    check('settlement_lines_net_valid', nonNegativeIntegerCheck(table.netCentimes)),
    check(
      'settlement_lines_expected_fee_valid',
      nonNegativeIntegerCheck(table.expectedFeeCentimes),
    ),
    check(
      'settlement_lines_status_valid',
      sql`${table.lineStatus} IN ('matched', 'fee_mismatch', 'unmatched')`,
    ),
    check('settlement_lines_created_at_iso', isoDateCheck(table.createdAt)),
  ],
);

export const adSpendDaily = sqliteTable(
  'ad_spend_daily',
  {
    storeId: text('store_id').notNull(),
    day: text('day').notNull(),
    platform: text('platform').notNull(),
    campaign: text('campaign').notNull().default(''),
    adSet: text('adset').notNull().default(''),
    adContent: text('ad_content').notNull().default(''),
    spendCentimes: integer('spend_centimes').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'ad_spend_daily_primary',
      columns: [
        table.storeId,
        table.day,
        table.platform,
        table.campaign,
        table.adSet,
        table.adContent,
      ],
    }),
    index('ad_spend_store_day_index').on(table.storeId, table.day),
    check('ad_spend_day_date', calendarDateCheck(table.day)),
    check('ad_spend_amount_valid', nonNegativeIntegerCheck(table.spendCentimes)),
    check('ad_spend_created_at_iso', isoDateCheck(table.createdAt)),
    check('ad_spend_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);
