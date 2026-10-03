DROP INDEX `shipments_order_index`;--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_store_order_unique` ON `shipments` (`store_id`,`order_id`);