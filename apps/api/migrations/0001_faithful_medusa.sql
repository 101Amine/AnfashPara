PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`price_centimes` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "products_price_centimes_non_negative" CHECK("__new_products"."price_centimes" >= 0),
	CONSTRAINT "products_price_centimes_integer" CHECK(typeof("__new_products"."price_centimes") = 'integer'),
	CONSTRAINT "products_active_boolean" CHECK("__new_products"."active" IN (0, 1)),
	CONSTRAINT "products_created_at_iso" CHECK("__new_products"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "products_updated_at_iso" CHECK("__new_products"."updated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "store_id", "slug", "name", "price_centimes", "active", "created_at", "updated_at") SELECT "id", "store_id", "slug", "name", "price_centimes", 1, "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `products_store_slug_unique` ON `products` (`store_id`,`slug`);--> statement-breakpoint
CREATE INDEX `products_store_id_index` ON `products` (`store_id`);
