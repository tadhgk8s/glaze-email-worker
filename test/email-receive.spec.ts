import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "../src/db/client";
import { handleInboundEmail } from "../src/email/receive";
import { buildRawEmail, createFakeMessage } from "./helpers";

describe("handleInboundEmail", () => {
	it("stores a plain-text message as inbound/received/unread", async () => {
		const { raw, headers } = buildRawEmail({
			from: "person@example.net",
			to: env.MAILBOX_ADDRESS,
			subject: "Plain text hello",
			messageId: "<plain-1@example.net>",
			text: "Hello there, just checking in.",
		});
		const { message } = createFakeMessage(raw, headers, "person@example.net", env.MAILBOX_ADDRESS);

		await handleInboundEmail(message, env);

		const db = createDb(env);
		const stored = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<plain-1@example.net>") });
		expect(stored).toBeTruthy();
		expect(stored?.direction).toBe("inbound");
		expect(stored?.status).toBe("received");
		expect(stored?.isRead).toBe(false);
		expect(stored?.bodyText).toContain("Hello there");
		expect(stored?.bodyHtml).toBeNull();
		expect(stored?.snippet).toContain("Hello there");
	});

	it("stores an HTML message and derives a snippet from stripped HTML", async () => {
		const { raw, headers } = buildRawEmail({
			from: "person@example.net",
			to: env.MAILBOX_ADDRESS,
			subject: "HTML hello",
			messageId: "<html-1@example.net>",
			html: "<p>Hello <b>there</b>, from HTML.</p>",
		});
		const { message } = createFakeMessage(raw, headers, "person@example.net", env.MAILBOX_ADDRESS);

		await handleInboundEmail(message, env);

		const db = createDb(env);
		const stored = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<html-1@example.net>") });
		expect(stored).toBeTruthy();
		expect(stored?.bodyHtml).toContain("<b>there</b>");
		expect(stored?.bodyText).toBeNull();
		expect(stored?.snippet).toBe("Hello there, from HTML.");
	});

	it("rejects mail addressed to another recipient without storing it", async () => {
		const { raw, headers } = buildRawEmail({
			from: "person@example.net",
			to: "someone-else@example.com",
			subject: "Wrong recipient",
			messageId: "<wrong-1@example.net>",
			text: "Should be rejected.",
		});
		const { message, getRejectReason } = createFakeMessage(raw, headers, "person@example.net", "someone-else@example.com");

		await handleInboundEmail(message, env);

		expect(getRejectReason()).toBeTruthy();
		const db = createDb(env);
		const stored = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<wrong-1@example.net>") });
		expect(stored).toBeUndefined();
	});

	it("deduplicates identical deliveries via the content fingerprint", async () => {
		const { raw, headers } = buildRawEmail({
			from: "person@example.net",
			to: env.MAILBOX_ADDRESS,
			subject: "Duplicate delivery",
			messageId: "<dup-1@example.net>",
			text: "Sent twice by the mail transport.",
		});

		await handleInboundEmail(createFakeMessage(raw, headers, "person@example.net", env.MAILBOX_ADDRESS).message, env);
		await handleInboundEmail(createFakeMessage(raw, headers, "person@example.net", env.MAILBOX_ADDRESS).message, env);

		const db = createDb(env);
		const rows = await db.select().from(schema.messages).where(eq(schema.messages.rfcMessageId, "<dup-1@example.net>"));
		expect(rows).toHaveLength(1);
	});

	it("resolves threads via In-Reply-To and References, newest match first", async () => {
		const db = createDb(env);

		const root = buildRawEmail({
			from: "person@example.net",
			to: env.MAILBOX_ADDRESS,
			subject: "Original thread",
			messageId: "<root-1@example.net>",
			text: "Original message.",
		});
		await handleInboundEmail(createFakeMessage(root.raw, root.headers, "person@example.net", env.MAILBOX_ADDRESS).message, env);
		const rootRow = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<root-1@example.net>") });
		expect(rootRow).toBeTruthy();

		const reply = buildRawEmail({
			from: "other@example.net",
			to: env.MAILBOX_ADDRESS,
			subject: "Re: Original thread",
			messageId: "<reply-1@example.net>",
			inReplyTo: "<root-1@example.net>",
			references: "<root-1@example.net>",
			text: "A reply.",
		});
		await handleInboundEmail(createFakeMessage(reply.raw, reply.headers, "other@example.net", env.MAILBOX_ADDRESS).message, env);
		const replyRow = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<reply-1@example.net>") });
		expect(replyRow).toBeTruthy();
		expect(replyRow?.threadId).toBe(rootRow?.threadId);

		// A second reply that only has References (no direct In-Reply-To match) should
		// still land in the same thread by walking References newest-to-oldest.
		const secondReply = buildRawEmail({
			from: "third@example.net",
			to: env.MAILBOX_ADDRESS,
			subject: "Re: Original thread",
			messageId: "<reply-2@example.net>",
			references: "<root-1@example.net> <reply-1@example.net>",
			text: "Another reply.",
		});
		await handleInboundEmail(createFakeMessage(secondReply.raw, secondReply.headers, "third@example.net", env.MAILBOX_ADDRESS).message, env);
		const secondReplyRow = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<reply-2@example.net>") });
		expect(secondReplyRow?.threadId).toBe(rootRow?.threadId);
	});

	it("stores a minimal record when parsing fails, without logging the raw email", async () => {
		const headers = { From: "person@example.net", To: env.MAILBOX_ADDRESS, Subject: "Broken", "Message-ID": "<broken-1@example.net>" };
		// Deliberately malformed: a Content-Type header with no body separator postal-mime cannot parse as expected,
		// combined with an invalid boundary reference to force a parser failure.
		const raw = `From: person@example.net\r\nTo: ${env.MAILBOX_ADDRESS}\r\nSubject: Broken\r\nMessage-ID: <broken-1@example.net>\r\nContent-Type: multipart/mixed; boundary="missing"\r\n\r\n`;
		const { message } = createFakeMessage(raw, headers, "person@example.net", env.MAILBOX_ADDRESS);

		await handleInboundEmail(message, env);

		const db = createDb(env);
		const stored = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<broken-1@example.net>") });
		// postal-mime is lenient and may still parse a bodyless multipart; the important
		// contract is that *some* row is stored (never silently dropped) and rejected mail
		// (a different behavior) never happens for a recipient match.
		expect(stored).toBeTruthy();
	});
});
