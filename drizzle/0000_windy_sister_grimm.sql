CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`rfc_message_id` text,
	`in_reply_to` text,
	`references_json` text NOT NULL,
	`from_json` text NOT NULL,
	`to_json` text NOT NULL,
	`cc_json` text NOT NULL,
	`bcc_json` text NOT NULL,
	`reply_to_json` text,
	`subject` text NOT NULL,
	`snippet` text NOT NULL,
	`body_text` text,
	`body_html` text,
	`is_read` integer NOT NULL,
	`sent_at` text,
	`received_at` text,
	`content_fingerprint` text,
	`provider_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_messages_direction_received_sent` ON `messages` (`direction`,`received_at`,`sent_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread_received_sent` ON `messages` (`thread_id`,`received_at`,`sent_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_updated_id` ON `messages` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_rfc_message_id` ON `messages` (`rfc_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_content_fingerprint` ON `messages` (`content_fingerprint`);--> statement-breakpoint
CREATE TABLE `send_requests` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`message_id` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
