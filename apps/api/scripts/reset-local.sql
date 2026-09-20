-- apps/api/scripts/reset-local.sql
PRAGMA foreign_keys = OFF;
DROP TABLE IF EXISTS settlement_lines;
DROP TABLE IF EXISTS courier_settlements;
DROP TABLE IF EXISTS shipment_events;
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS confirmation_attempts;
DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS webhook_inbox;
DROP TABLE IF EXISTS inventory_movements;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS ad_spend_daily;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS d1_migrations;
PRAGMA foreign_keys = ON;
