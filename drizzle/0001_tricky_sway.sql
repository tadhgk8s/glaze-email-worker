ALTER TABLE `messages` ADD `is_starred` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `is_archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `idx_messages_starred` ON `messages` (`is_starred`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_archived` ON `messages` (`is_archived`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_deleted` ON `messages` (`deleted_at`);