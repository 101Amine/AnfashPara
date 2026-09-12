import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const isoDateCheck = (column: AnySQLiteColumn) => sql`${column} GLOB '????-??-??T??:??:??.???Z'`;

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    priceCentimes: integer('price_centimes').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('products_store_slug_unique').on(table.storeId, table.slug),
    index('products_store_id_index').on(table.storeId),
    check('products_price_centimes_non_negative', sql`${table.priceCentimes} >= 0`),
    check('products_price_centimes_integer', sql`typeof(${table.priceCentimes}) = 'integer'`),
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
    check('settings_minimum_order_non_negative', sql`${table.minimumOrderCentimes} >= 0`),
    check('settings_minimum_order_integer', sql`typeof(${table.minimumOrderCentimes}) = 'integer'`),
    check('settings_created_at_iso', isoDateCheck(table.createdAt)),
    check('settings_updated_at_iso', isoDateCheck(table.updatedAt)),
  ],
);
