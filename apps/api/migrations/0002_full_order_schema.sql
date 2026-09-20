CREATE TABLE `ad_spend_daily` (
	`store_id` text NOT NULL,
	`day` text NOT NULL,
	`platform` text NOT NULL,
	`campaign` text DEFAULT '' NOT NULL,
	`adset` text DEFAULT '' NOT NULL,
	`ad_content` text DEFAULT '' NOT NULL,
	`spend_centimes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`store_id`, `day`, `platform`, `campaign`, `adset`, `ad_content`),
	CONSTRAINT "ad_spend_day_date" CHECK("ad_spend_daily"."day" GLOB '????-??-??'),
	CONSTRAINT "ad_spend_amount_valid" CHECK(typeof("ad_spend_daily"."spend_centimes") = 'integer' AND "ad_spend_daily"."spend_centimes" >= 0),
	CONSTRAINT "ad_spend_created_at_iso" CHECK("ad_spend_daily"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "ad_spend_updated_at_iso" CHECK("ad_spend_daily"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `ad_spend_store_day_index` ON `ad_spend_daily` (`store_id`,`day`);--> statement-breakpoint
CREATE TABLE `confirmation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`order_id` text NOT NULL,
	`channel` text NOT NULL,
	`outcome` text NOT NULL,
	`attempted_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "confirmation_attempts_id_uuid_v7" CHECK(length("confirmation_attempts"."id") = 36 AND substr("confirmation_attempts"."id", 9, 1) = '-' AND substr("confirmation_attempts"."id", 14, 1) = '-' AND substr("confirmation_attempts"."id", 15, 1) = '7' AND substr("confirmation_attempts"."id", 19, 1) = '-' AND lower(substr("confirmation_attempts"."id", 20, 1)) GLOB '[89ab]' AND substr("confirmation_attempts"."id", 24, 1) = '-'),
	CONSTRAINT "confirmation_attempts_channel_valid" CHECK("confirmation_attempts"."channel" IN ('call', 'whatsapp')),
	CONSTRAINT "confirmation_attempts_outcome_valid" CHECK("confirmation_attempts"."outcome" IN ('confirmed', 'no_answer', 'cancelled', 'callback', 'wrong_number')),
	CONSTRAINT "confirmation_attempts_created_at_iso" CHECK("confirmation_attempts"."created_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `confirmation_attempts_order_created_index` ON `confirmation_attempts` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `courier_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`courier` text NOT NULL,
	`statement_reference` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`amount_paid_centimes` integer NOT NULL,
	`imported_at` text NOT NULL,
	`source_file` text,
	CONSTRAINT "courier_settlements_id_uuid_v7" CHECK(length("courier_settlements"."id") = 36 AND substr("courier_settlements"."id", 9, 1) = '-' AND substr("courier_settlements"."id", 14, 1) = '-' AND substr("courier_settlements"."id", 15, 1) = '7' AND substr("courier_settlements"."id", 19, 1) = '-' AND lower(substr("courier_settlements"."id", 20, 1)) GLOB '[89ab]' AND substr("courier_settlements"."id", 24, 1) = '-'),
	CONSTRAINT "courier_settlements_period_start_date" CHECK("courier_settlements"."period_start" GLOB '????-??-??'),
	CONSTRAINT "courier_settlements_period_end_date" CHECK("courier_settlements"."period_end" GLOB '????-??-??'),
	CONSTRAINT "courier_settlements_period_order" CHECK("courier_settlements"."period_start" <= "courier_settlements"."period_end"),
	CONSTRAINT "courier_settlements_amount_paid_valid" CHECK(typeof("courier_settlements"."amount_paid_centimes") = 'integer' AND "courier_settlements"."amount_paid_centimes" >= 0),
	CONSTRAINT "courier_settlements_imported_at_iso" CHECK("courier_settlements"."imported_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courier_settlements_store_statement_unique` ON `courier_settlements` (`store_id`,`courier`,`statement_reference`);--> statement-breakpoint
CREATE INDEX `courier_settlements_store_imported_index` ON `courier_settlements` (`store_id`,`imported_at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`phone_e164` text NOT NULL,
	`name` text,
	`city` text,
	`orders_count` integer DEFAULT 0 NOT NULL,
	`delivered_count` integer DEFAULT 0 NOT NULL,
	`refused_count` integer DEFAULT 0 NOT NULL,
	`blacklisted` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "customers_id_uuid_v7" CHECK(length("customers"."id") = 36 AND substr("customers"."id", 9, 1) = '-' AND substr("customers"."id", 14, 1) = '-' AND substr("customers"."id", 15, 1) = '7' AND substr("customers"."id", 19, 1) = '-' AND lower(substr("customers"."id", 20, 1)) GLOB '[89ab]' AND substr("customers"."id", 24, 1) = '-'),
	CONSTRAINT "customers_phone_e164_ma" CHECK("customers"."phone_e164" GLOB '+212[67]????????'),
	CONSTRAINT "customers_orders_count_valid" CHECK(typeof("customers"."orders_count") = 'integer' AND "customers"."orders_count" >= 0),
	CONSTRAINT "customers_delivered_count_valid" CHECK(typeof("customers"."delivered_count") = 'integer' AND "customers"."delivered_count" >= 0),
	CONSTRAINT "customers_refused_count_valid" CHECK(typeof("customers"."refused_count") = 'integer' AND "customers"."refused_count" >= 0),
	CONSTRAINT "customers_blacklisted_boolean" CHECK("customers"."blacklisted" IN (0, 1)),
	CONSTRAINT "customers_created_at_iso" CHECK("customers"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "customers_updated_at_iso" CHECK("customers"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_store_phone_unique` ON `customers` (`store_id`,`phone_e164`);--> statement-breakpoint
CREATE INDEX `customers_store_blacklisted_index` ON `customers` (`store_id`,`blacklisted`);--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`sku` text NOT NULL,
	`quantity` integer NOT NULL,
	`reason` text NOT NULL,
	`reference` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`sku`) REFERENCES `products`(`sku`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_id_uuid_v7" CHECK(length("inventory_movements"."id") = 36 AND substr("inventory_movements"."id", 9, 1) = '-' AND substr("inventory_movements"."id", 14, 1) = '-' AND substr("inventory_movements"."id", 15, 1) = '7' AND substr("inventory_movements"."id", 19, 1) = '-' AND lower(substr("inventory_movements"."id", 20, 1)) GLOB '[89ab]' AND substr("inventory_movements"."id", 24, 1) = '-'),
	CONSTRAINT "inventory_quantity_non_zero" CHECK(typeof("inventory_movements"."quantity") = 'integer' AND "inventory_movements"."quantity" <> 0),
	CONSTRAINT "inventory_reason_valid" CHECK("inventory_movements"."reason" IN ('purchase', 'shipped', 'returned', 'damaged', 'adjustment')),
	CONSTRAINT "inventory_created_at_iso" CHECK("inventory_movements"."created_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `inventory_store_sku_created_index` ON `inventory_movements` (`store_id`,`sku`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`order_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text,
	`payload_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_events_id_uuid_v7" CHECK(length("order_events"."id") = 36 AND substr("order_events"."id", 9, 1) = '-' AND substr("order_events"."id", 14, 1) = '-' AND substr("order_events"."id", 15, 1) = '7' AND substr("order_events"."id", 19, 1) = '-' AND lower(substr("order_events"."id", 20, 1)) GLOB '[89ab]' AND substr("order_events"."id", 24, 1) = '-'),
	CONSTRAINT "order_events_from_status_valid" CHECK("order_events"."from_status" IS NULL OR "order_events"."from_status" IN ('NEW', 'CONFIRMING', 'NO_ANSWER', 'CONFIRMED', 'CANCELLED', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED')),
	CONSTRAINT "order_events_to_status_valid" CHECK("order_events"."to_status" IN ('NEW', 'CONFIRMING', 'NO_ANSWER', 'CONFIRMED', 'CANCELLED', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED')),
	CONSTRAINT "order_events_payload_json" CHECK("order_events"."payload_json" IS NULL OR (json_valid("order_events"."payload_json"))),
	CONSTRAINT "order_events_created_at_iso" CHECK("order_events"."created_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `order_events_order_created_index` ON `order_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`order_id` text NOT NULL,
	`sku` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_centimes` integer NOT NULL,
	`unit_cogs_centimes` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sku`) REFERENCES `products`(`sku`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_items_id_uuid_v7" CHECK(length("order_items"."id") = 36 AND substr("order_items"."id", 9, 1) = '-' AND substr("order_items"."id", 14, 1) = '-' AND substr("order_items"."id", 15, 1) = '7' AND substr("order_items"."id", 19, 1) = '-' AND lower(substr("order_items"."id", 20, 1)) GLOB '[89ab]' AND substr("order_items"."id", 24, 1) = '-'),
	CONSTRAINT "order_items_quantity_valid" CHECK(typeof("order_items"."quantity") = 'integer' AND "order_items"."quantity" > 0),
	CONSTRAINT "order_items_unit_price_valid" CHECK(typeof("order_items"."unit_price_centimes") = 'integer' AND "order_items"."unit_price_centimes" >= 0),
	CONSTRAINT "order_items_unit_cogs_valid" CHECK(typeof("order_items"."unit_cogs_centimes") = 'integer' AND "order_items"."unit_cogs_centimes" >= 0),
	CONSTRAINT "order_items_created_at_iso" CHECK("order_items"."created_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `order_items_order_index` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_store_sku_index` ON `order_items` (`store_id`,`sku`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`external_id` text NOT NULL,
	`order_number` text,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'NEW' NOT NULL,
	`cod_amount_centimes` integer NOT NULL,
	`shipping_fee_customer_centimes` integer DEFAULT 0 NOT NULL,
	`city` text,
	`address` text,
	`note` text,
	`utm_source` text,
	`utm_campaign` text,
	`utm_content` text,
	`placed_at` text NOT NULL,
	`confirmed_at` text,
	`shipped_at` text,
	`closed_at` text,
	`raw_payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_id_uuid_v7" CHECK(length("orders"."id") = 36 AND substr("orders"."id", 9, 1) = '-' AND substr("orders"."id", 14, 1) = '-' AND substr("orders"."id", 15, 1) = '7' AND substr("orders"."id", 19, 1) = '-' AND lower(substr("orders"."id", 20, 1)) GLOB '[89ab]' AND substr("orders"."id", 24, 1) = '-'),
	CONSTRAINT "orders_status_valid" CHECK("orders"."status" IN ('NEW', 'CONFIRMING', 'NO_ANSWER', 'CONFIRMED', 'CANCELLED', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUSED', 'RETURNED', 'SETTLED')),
	CONSTRAINT "orders_cod_amount_valid" CHECK(typeof("orders"."cod_amount_centimes") = 'integer' AND "orders"."cod_amount_centimes" >= 0),
	CONSTRAINT "orders_shipping_fee_customer_valid" CHECK(typeof("orders"."shipping_fee_customer_centimes") = 'integer' AND "orders"."shipping_fee_customer_centimes" >= 0),
	CONSTRAINT "orders_placed_at_iso" CHECK("orders"."placed_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "orders_confirmed_at_iso" CHECK("orders"."confirmed_at" IS NULL OR ("orders"."confirmed_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "orders_shipped_at_iso" CHECK("orders"."shipped_at" IS NULL OR ("orders"."shipped_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "orders_closed_at_iso" CHECK("orders"."closed_at" IS NULL OR ("orders"."closed_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "orders_raw_payload_json" CHECK(json_valid("orders"."raw_payload_json")),
	CONSTRAINT "orders_created_at_iso" CHECK("orders"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "orders_updated_at_iso" CHECK("orders"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_store_external_unique` ON `orders` (`store_id`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_store_number_unique` ON `orders` (`store_id`,`order_number`);--> statement-breakpoint
CREATE INDEX `orders_store_status_placed_index` ON `orders` (`store_id`,`status`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_customer_placed_index` ON `orders` (`customer_id`,`placed_at`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`topic` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`processed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "outbox_id_uuid_v7" CHECK(length("outbox"."id") = 36 AND substr("outbox"."id", 9, 1) = '-' AND substr("outbox"."id", 14, 1) = '-' AND substr("outbox"."id", 15, 1) = '7' AND substr("outbox"."id", 19, 1) = '-' AND lower(substr("outbox"."id", 20, 1)) GLOB '[89ab]' AND substr("outbox"."id", 24, 1) = '-'),
	CONSTRAINT "outbox_payload_json" CHECK(json_valid("outbox"."payload_json")),
	CONSTRAINT "outbox_status_valid" CHECK("outbox"."status" IN ('pending', 'processing', 'done', 'failed')),
	CONSTRAINT "outbox_attempts_valid" CHECK(typeof("outbox"."attempts") = 'integer' AND "outbox"."attempts" >= 0),
	CONSTRAINT "outbox_next_attempt_at_iso" CHECK("outbox"."next_attempt_at" IS NULL OR ("outbox"."next_attempt_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "outbox_processed_at_iso" CHECK("outbox"."processed_at" IS NULL OR ("outbox"."processed_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "outbox_created_at_iso" CHECK("outbox"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "outbox_updated_at_iso" CHECK("outbox"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `outbox_dispatch_index` ON `outbox` (`store_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `outbox_aggregate_index` ON `outbox` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `settlement_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`tracking_number` text NOT NULL,
	`cod_collected_centimes` integer NOT NULL,
	`fee_centimes` integer NOT NULL,
	`net_centimes` integer NOT NULL,
	`expected_fee_centimes` integer NOT NULL,
	`line_status` text NOT NULL,
	`shipment_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`settlement_id`) REFERENCES `courier_settlements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "settlement_lines_id_uuid_v7" CHECK(length("settlement_lines"."id") = 36 AND substr("settlement_lines"."id", 9, 1) = '-' AND substr("settlement_lines"."id", 14, 1) = '-' AND substr("settlement_lines"."id", 15, 1) = '7' AND substr("settlement_lines"."id", 19, 1) = '-' AND lower(substr("settlement_lines"."id", 20, 1)) GLOB '[89ab]' AND substr("settlement_lines"."id", 24, 1) = '-'),
	CONSTRAINT "settlement_lines_cod_collected_valid" CHECK(typeof("settlement_lines"."cod_collected_centimes") = 'integer' AND "settlement_lines"."cod_collected_centimes" >= 0),
	CONSTRAINT "settlement_lines_fee_valid" CHECK(typeof("settlement_lines"."fee_centimes") = 'integer' AND "settlement_lines"."fee_centimes" >= 0),
	CONSTRAINT "settlement_lines_net_valid" CHECK(typeof("settlement_lines"."net_centimes") = 'integer' AND "settlement_lines"."net_centimes" >= 0),
	CONSTRAINT "settlement_lines_expected_fee_valid" CHECK(typeof("settlement_lines"."expected_fee_centimes") = 'integer' AND "settlement_lines"."expected_fee_centimes" >= 0),
	CONSTRAINT "settlement_lines_status_valid" CHECK("settlement_lines"."line_status" IN ('matched', 'fee_mismatch', 'unmatched')),
	CONSTRAINT "settlement_lines_created_at_iso" CHECK("settlement_lines"."created_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `settlement_lines_settlement_index` ON `settlement_lines` (`settlement_id`);--> statement-breakpoint
CREATE INDEX `settlement_lines_tracking_index` ON `settlement_lines` (`store_id`,`tracking_number`);--> statement-breakpoint
CREATE INDEX `settlement_lines_shipment_index` ON `settlement_lines` (`shipment_id`);--> statement-breakpoint
CREATE TABLE `shipment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`shipment_id` text NOT NULL,
	`courier_status` text NOT NULL,
	`status_normalized` text NOT NULL,
	`occurred_at` text NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "shipment_events_id_uuid_v7" CHECK(length("shipment_events"."id") = 36 AND substr("shipment_events"."id", 9, 1) = '-' AND substr("shipment_events"."id", 14, 1) = '-' AND substr("shipment_events"."id", 15, 1) = '7' AND substr("shipment_events"."id", 19, 1) = '-' AND lower(substr("shipment_events"."id", 20, 1)) GLOB '[89ab]' AND substr("shipment_events"."id", 24, 1) = '-'),
	CONSTRAINT "shipment_events_status_normalized_valid" CHECK("shipment_events"."status_normalized" IN ('created', 'picked', 'in_transit', 'out_for_delivery', 'delivered', 'refused', 'returned', 'lost')),
	CONSTRAINT "shipment_events_occurred_at_iso" CHECK("shipment_events"."occurred_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "shipment_events_payload_json" CHECK(json_valid("shipment_events"."payload_json"))
);
--> statement-breakpoint
CREATE INDEX `shipment_events_shipment_occurred_index` ON `shipment_events` (`shipment_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`order_id` text NOT NULL,
	`courier` text NOT NULL,
	`tracking_number` text NOT NULL,
	`courier_status` text,
	`status_normalized` text NOT NULL,
	`delivery_fee_centimes` integer,
	`return_fee_centimes` integer,
	`label_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipments_id_uuid_v7" CHECK(length("shipments"."id") = 36 AND substr("shipments"."id", 9, 1) = '-' AND substr("shipments"."id", 14, 1) = '-' AND substr("shipments"."id", 15, 1) = '7' AND substr("shipments"."id", 19, 1) = '-' AND lower(substr("shipments"."id", 20, 1)) GLOB '[89ab]' AND substr("shipments"."id", 24, 1) = '-'),
	CONSTRAINT "shipments_status_normalized_valid" CHECK("shipments"."status_normalized" IN ('created', 'picked', 'in_transit', 'out_for_delivery', 'delivered', 'refused', 'returned', 'lost')),
	CONSTRAINT "shipments_delivery_fee_valid" CHECK("shipments"."delivery_fee_centimes" IS NULL OR (typeof("shipments"."delivery_fee_centimes") = 'integer' AND "shipments"."delivery_fee_centimes" >= 0)),
	CONSTRAINT "shipments_return_fee_valid" CHECK("shipments"."return_fee_centimes" IS NULL OR (typeof("shipments"."return_fee_centimes") = 'integer' AND "shipments"."return_fee_centimes" >= 0)),
	CONSTRAINT "shipments_created_at_iso" CHECK("shipments"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "shipments_updated_at_iso" CHECK("shipments"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_store_tracking_unique` ON `shipments` (`store_id`,`tracking_number`);--> statement-breakpoint
CREATE INDEX `shipments_order_index` ON `shipments` (`order_id`);--> statement-breakpoint
CREATE INDEX `shipments_store_status_index` ON `shipments` (`store_id`,`status_normalized`);--> statement-breakpoint
CREATE TABLE `webhook_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`source` text NOT NULL,
	`external_event_id` text NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text,
	`error` text,
	`payload_json` text NOT NULL,
	CONSTRAINT "webhook_inbox_id_uuid_v7" CHECK(length("webhook_inbox"."id") = 36 AND substr("webhook_inbox"."id", 9, 1) = '-' AND substr("webhook_inbox"."id", 14, 1) = '-' AND substr("webhook_inbox"."id", 15, 1) = '7' AND substr("webhook_inbox"."id", 19, 1) = '-' AND lower(substr("webhook_inbox"."id", 20, 1)) GLOB '[89ab]' AND substr("webhook_inbox"."id", 24, 1) = '-'),
	CONSTRAINT "webhook_inbox_received_at_iso" CHECK("webhook_inbox"."received_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "webhook_inbox_processed_at_iso" CHECK("webhook_inbox"."processed_at" IS NULL OR ("webhook_inbox"."processed_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "webhook_inbox_payload_json" CHECK(json_valid("webhook_inbox"."payload_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_inbox_store_source_event_unique` ON `webhook_inbox` (`store_id`,`source`,`external_event_id`);--> statement-breakpoint
CREATE INDEX `webhook_inbox_unprocessed_index` ON `webhook_inbox` (`store_id`,`processed_at`,`received_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`sku` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`cogs_centimes` integer DEFAULT 0 NOT NULL,
	`price_centimes` integer NOT NULL,
	`compare_at_centimes` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "products_sku_not_empty" CHECK(length(trim("__new_products"."sku")) > 0),
	CONSTRAINT "products_cogs_centimes_valid" CHECK(typeof("__new_products"."cogs_centimes") = 'integer' AND "__new_products"."cogs_centimes" >= 0),
	CONSTRAINT "products_price_centimes_valid" CHECK(typeof("__new_products"."price_centimes") = 'integer' AND "__new_products"."price_centimes" >= 0),
	CONSTRAINT "products_compare_at_centimes_valid" CHECK("__new_products"."compare_at_centimes" IS NULL OR (typeof("__new_products"."compare_at_centimes") = 'integer' AND "__new_products"."compare_at_centimes" >= 0)),
	CONSTRAINT "products_active_boolean" CHECK("__new_products"."active" IN (0, 1)),
	CONSTRAINT "products_created_at_iso" CHECK("__new_products"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "products_updated_at_iso" CHECK("__new_products"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "store_id", "sku", "slug", "name", "brand", "cogs_centimes", "price_centimes", "compare_at_centimes", "active", "created_at", "updated_at") SELECT "id", "store_id", "slug", "slug", "name", NULL, 0, "price_centimes", NULL, "active", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_unique` ON `products` (`sku`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_store_sku_unique` ON `products` (`store_id`,`sku`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_store_slug_unique` ON `products` (`store_id`,`slug`);--> statement-breakpoint
CREATE INDEX `products_store_active_index` ON `products` (`store_id`,`active`);--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`store_id` text PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'MAD' NOT NULL,
	`locale` text DEFAULT 'fr-MA' NOT NULL,
	`timezone` text DEFAULT 'Africa/Casablanca' NOT NULL,
	`minimum_order_centimes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "settings_currency_iso_4217" CHECK(length("__new_settings"."currency") = 3),
	CONSTRAINT "settings_minimum_order_valid" CHECK(typeof("__new_settings"."minimum_order_centimes") = 'integer' AND "__new_settings"."minimum_order_centimes" >= 0),
	CONSTRAINT "settings_created_at_iso" CHECK("__new_settings"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "settings_updated_at_iso" CHECK("__new_settings"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
INSERT INTO `__new_settings`("store_id", "currency", "locale", "timezone", "minimum_order_centimes", "created_at", "updated_at") SELECT "store_id", "currency", "locale", "timezone", "minimum_order_centimes", "created_at", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;
