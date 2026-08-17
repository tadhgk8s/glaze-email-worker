import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Every inbound and outbound message the Worker knows about.
 *
 * JSON columns (`*Json`) store parsed address objects/arrays as text because
 * D1/SQLite has no native JSON type. Always JSON.parse/JSON.stringify at the
 * application boundary.
 */
export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		threadId: text("thread_id").notNull(),
		direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
		status: text("status", {
			enum: ["received", "sending", "sent", "failed", "unknown"],
		}).notNull(),
		rfcMessageId: text("rfc_message_id"),
		inReplyTo: text("in_reply_to"),
		referencesJson: text("references_json").notNull(),
		fromJson: text("from_json").notNull(),
		toJson: text("to_json").notNull(),
		ccJson: text("cc_json").notNull(),
		bccJson: text("bcc_json").notNull(),
		replyToJson: text("reply_to_json"),
		subject: text("subject").notNull(),
		snippet: text("snippet").notNull(),
		bodyText: text("body_text"),
		bodyHtml: text("body_html"),
		isRead: integer("is_read", { mode: "boolean" }).notNull(),
		isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
		isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
		deletedAt: text("deleted_at"),
		sentAt: text("sent_at"),
		receivedAt: text("received_at"),
		contentFingerprint: text("content_fingerprint"),
		providerMessageId: text("provider_message_id"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_messages_direction_received_sent").on(table.direction, table.receivedAt, table.sentAt),
		index("idx_messages_thread_received_sent").on(table.threadId, table.receivedAt, table.sentAt),
		index("idx_messages_updated_id").on(table.updatedAt, table.id),
		index("idx_messages_rfc_message_id").on(table.rfcMessageId),
		index("idx_messages_starred").on(table.isStarred, table.updatedAt),
		index("idx_messages_archived").on(table.isArchived, table.updatedAt),
		index("idx_messages_deleted").on(table.deletedAt),
		uniqueIndex("uq_messages_content_fingerprint").on(table.contentFingerprint),
	],
);

/**
 * One row per client-generated `Idempotency-Key` on `POST /v1/send`. Reserved
 * before the outbound message row is created and before `EMAIL.send()` is
 * called, so retries can detect in-progress/duplicate sends.
 */
export const sendRequests = sqliteTable("send_requests", {
	idempotencyKey: text("idempotency_key").primaryKey(),
	payloadHash: text("payload_hash").notNull(),
	messageId: text("message_id").notNull(),
	status: text("status", {
		enum: ["preparing", "sending", "sent", "failed", "unknown"],
	}).notNull(),
	errorCode: text("error_code"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type SendRequest = typeof sendRequests.$inferSelect;
export type NewSendRequest = typeof sendRequests.$inferInsert;
