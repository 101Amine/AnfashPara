CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`price_centimes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "products_price_centimes_non_negative" CHECK("products"."price_centimes" >= 0),
	CONSTRAINT "products_price_centimes_integer" CHECK(typeof("products"."price_centimes") = 'integer'),
	CONSTRAINT "products_created_at_iso" CHECK("products"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "products_updated_at_iso" CHECK("products"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_store_slug_unique` ON `products` (`store_id`,`slug`);--> statement-breakpoint
CREATE INDEX `products_store_id_index` ON `products` (`store_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`store_id` text PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'MAD' NOT NULL,
	`locale` text DEFAULT 'fr-MA' NOT NULL,
	`timezone` text DEFAULT 'Africa/Casablanca' NOT NULL,
	`minimum_order_centimes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "settings_currency_iso_4217" CHECK(length("settings"."currency") = 3),
	CONSTRAINT "settings_minimum_order_non_negative" CHECK("settings"."minimum_order_centimes" >= 0),
	CONSTRAINT "settings_minimum_order_integer" CHECK(typeof("settings"."minimum_order_centimes") = 'integer'),
	CONSTRAINT "settings_created_at_iso" CHECK("settings"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "settings_updated_at_iso" CHECK("settings"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
