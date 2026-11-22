CREATE TABLE `stock_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`order_id` text NOT NULL,
	`sku` text NOT NULL,
	`quantity` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`closed_at` text,
	`closed_by` text,
	`close_reason` text,
	FOREIGN KEY (`store_id`,`order_id`) REFERENCES `orders`(`store_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`,`sku`) REFERENCES `products`(`store_id`,`sku`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_reservations_id_uuid_v7" CHECK(length("stock_reservations"."id") = 36 AND substr("stock_reservations"."id", 9, 1) = '-' AND substr("stock_reservations"."id", 14, 1) = '-' AND substr("stock_reservations"."id", 15, 1) = '7' AND substr("stock_reservations"."id", 19, 1) = '-' AND lower(substr("stock_reservations"."id", 20, 1)) GLOB '[89ab]' AND substr("stock_reservations"."id", 24, 1) = '-'),
	CONSTRAINT "stock_reservations_quantity_valid" CHECK(typeof("stock_reservations"."quantity") = 'integer' AND "stock_reservations"."quantity" > 0),
	CONSTRAINT "stock_reservations_status_valid" CHECK("stock_reservations"."status" IN ('active', 'released', 'consumed')),
	CONSTRAINT "stock_reservations_created_at_iso" CHECK("stock_reservations"."created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "stock_reservations_created_by_required" CHECK(length(trim("stock_reservations"."created_by")) > 0),
	CONSTRAINT "stock_reservations_closure_valid" CHECK(
      ("stock_reservations"."status" = 'active' AND "stock_reservations"."closed_at" IS NULL AND "stock_reservations"."closed_by" IS NULL AND "stock_reservations"."close_reason" IS NULL)
      OR ("stock_reservations"."status" IN ('released', 'consumed')
        AND "stock_reservations"."closed_at" IS NOT NULL AND "stock_reservations"."closed_at" GLOB '????-??-??T??:??:??.???Z'
        AND "stock_reservations"."closed_at" >= "stock_reservations"."created_at"
        AND "stock_reservations"."closed_by" IS NOT NULL AND length(trim("stock_reservations"."closed_by")) > 0
        AND "stock_reservations"."close_reason" IS NOT NULL AND length(trim("stock_reservations"."close_reason")) > 0)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_reservations_order_sku_unique` ON `stock_reservations` (`store_id`,`order_id`,`sku`);--> statement-breakpoint
CREATE INDEX `stock_reservations_available_index` ON `stock_reservations` (`store_id`,`sku`,`status`);--> statement-breakpoint
CREATE INDEX `stock_reservations_review_index` ON `stock_reservations` (`store_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_store_id_unique` ON `orders` (`store_id`,`id`);
--> statement-breakpoint
-- Custom lifecycle guards: Drizzle snapshots do not represent SQLite triggers.
-- Preserve these guards when rebuilding this table in a future migration.
-- REPLACE may bypass DELETE triggers depending on SQLite recursive_triggers;
-- reject replacement explicitly so terminal history cannot be resurrected.
CREATE TRIGGER stock_reservations_no_replacement
BEFORE INSERT ON stock_reservations
WHEN EXISTS (
  SELECT 1 FROM stock_reservations r WHERE r.id = NEW.id
    OR (r.store_id = NEW.store_id AND r.order_id = NEW.order_id AND r.sku = NEW.sku)
)
BEGIN
  SELECT RAISE(ABORT, 'reservation_already_exists');
END;
--> statement-breakpoint
CREATE TRIGGER stock_reservations_start_active
BEFORE INSERT ON stock_reservations
WHEN NEW.status <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'reservation_must_start_active');
END;
--> statement-breakpoint
CREATE TRIGGER stock_reservations_immutable_acquisition
BEFORE UPDATE ON stock_reservations
WHEN NEW.id IS NOT OLD.id OR NEW.store_id IS NOT OLD.store_id
  OR NEW.order_id IS NOT OLD.order_id OR NEW.sku IS NOT OLD.sku
  OR NEW.quantity IS NOT OLD.quantity OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'reservation_acquisition_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER stock_reservations_terminal_immutable
BEFORE UPDATE ON stock_reservations
WHEN OLD.status <> 'active' AND (
  NEW.status IS NOT OLD.status OR NEW.closed_at IS NOT OLD.closed_at
  OR NEW.closed_by IS NOT OLD.closed_by OR NEW.close_reason IS NOT OLD.close_reason
)
BEGIN
  SELECT RAISE(ABORT, 'reservation_terminal_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER stock_reservations_preserve_history
BEFORE DELETE ON stock_reservations
BEGIN
  SELECT RAISE(ABORT, 'reservation_history_required');
END;
