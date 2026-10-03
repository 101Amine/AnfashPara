ALTER TABLE `inventory_movements` ADD `operation_reason` text;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `note` text;--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_admin_reference_unique` ON `inventory_movements` (`store_id`,`reference`) WHERE "inventory_movements"."operation_reason" IS NOT NULL;