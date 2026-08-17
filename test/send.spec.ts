import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "../src/db/client";
import { normalizeEmailError } from "../src/email/send";
import { handleInboundEmail } from "../src/email/receive";
import { buildRawEmail, createFakeMessage } from "./helpers";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${env.APP_TOKEN}`, "Content-Type": "application/json", ...extra };
}

interface SendSuccessBody {
	data: { message: { id: string; threadId: string; status: string; providerMessageId: string | null; sentAt: string | null } };
}
interface ErrorBody {
	error: { code: string };
}

describe("normalizeEmailError", () => {
	it("classifies known validation-style codes as definitive failures", () => {
		expect(normalizeEmailError({ code: "E_SENDER_NOT_VERIFIED" })).toEqual({ code: "E_SENDER_NOT_VERIFIED", definitive: true });
		expect(normalizeEmailError({ code: "E_TOO_MANY_RECIPIENTS" }).definitive).toBe(true);
	});

	it("classifies transient or unrecognized errors as indeterminate", () => {
		expect(normalizeEmailError({ code: "E_RATE_LIMIT_EXCEEDED" }).definitive).toBe(false);
		expect(normalizeEmailError({ code: "E_DELIVERY_FAILED" }).definitive).toBe(false);
		const fromPlainError = normalizeEmailError(new Error("network blip"));
		expect(fromPlainError).toEqual({ code: "E_UNKNOWN", definitive: false });
	});
});

describe("POST /v1/send", () => {
	it("rejects unauthenticated requests", async () => {
		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
			body: JSON.stringify({ to: [{ address: "person@example.net" }], subject: "Hi", text: "Hi" }),
		});
		expect(response.status).toBe(401);
	});

	it("requires a valid Idempotency-Key header", async () => {
		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ to: [{ address: "person@example.net" }], subject: "Hi", text: "Hi" }),
		});
		expect(response.status).toBe(400);
	});

	it("rejects a body with no recipients", async () => {
		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": crypto.randomUUID() }),
			body: JSON.stringify({ to: [], subject: "Hi", text: "Hi" }),
		});
		expect(response.status).toBe(422);
		const body = (await response.json()) as ErrorBody;
		expect(body.error.code).toBe("VALIDATION_FAILED");
	});

	it("rejects a body with neither text nor html", async () => {
		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": crypto.randomUUID() }),
			body: JSON.stringify({ to: [{ address: "person@example.net" }], subject: "Hi" }),
		});
		expect(response.status).toBe(422);
	});

	it("sends a new message and records it as sent", async () => {
		const idempotencyKey = crypto.randomUUID();
		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": idempotencyKey }),
			body: JSON.stringify({
				to: [{ address: "person@example.net", name: "Person" }],
				subject: "Hello",
				text: "Plain text body",
				html: "<p>HTML body</p>",
			}),
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as SendSuccessBody;
		expect(body.data.message.status).toBe("sent");
		expect(body.data.message.sentAt).toBeTruthy();

		const db = createDb(env);
		const stored = await db.query.messages.findFirst({ where: eq(schema.messages.id, body.data.message.id) });
		expect(stored?.direction).toBe("outbound");
		expect(stored?.status).toBe("sent");

		const sendRequest = await db.query.sendRequests.findFirst({ where: eq(schema.sendRequests.idempotencyKey, idempotencyKey) });
		expect(sendRequest?.status).toBe("sent");
	});

	it("returns the original result when the idempotency key is reused with the same payload", async () => {
		const idempotencyKey = crypto.randomUUID();
		const payload = { to: [{ address: "person@example.net" }], subject: "Idempotent hello", text: "Once only, please." };

		const first = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": idempotencyKey }),
			body: JSON.stringify(payload),
		});
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as SendSuccessBody;

		const second = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": idempotencyKey }),
			body: JSON.stringify(payload),
		});
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as SendSuccessBody;
		expect(secondBody.data.message.id).toBe(firstBody.data.message.id);

		const db = createDb(env);
		const rows = await db.select().from(schema.messages).where(eq(schema.messages.id, firstBody.data.message.id));
		expect(rows).toHaveLength(1);
	});

	it("rejects a reused idempotency key sent with a different payload", async () => {
		const idempotencyKey = crypto.randomUUID();
		await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": idempotencyKey }),
			body: JSON.stringify({ to: [{ address: "person@example.net" }], subject: "First", text: "First payload." }),
		});

		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": idempotencyKey }),
			body: JSON.stringify({ to: [{ address: "person@example.net" }], subject: "Second", text: "Different payload." }),
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as ErrorBody;
		expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
	});

	it("sends a threaded reply with In-Reply-To/References derived from the original message", async () => {
		const { raw, headers } = buildRawEmail({
			from: "person@example.net",
			to: env.MAILBOX_ADDRESS,
			subject: "Original for reply",
			messageId: "<orig-reply-1@example.net>",
			text: "Original body.",
		});
		await handleInboundEmail(createFakeMessage(raw, headers, "person@example.net", env.MAILBOX_ADDRESS).message, env);

		const db = createDb(env);
		const original = await db.query.messages.findFirst({ where: eq(schema.messages.rfcMessageId, "<orig-reply-1@example.net>") });
		expect(original).toBeTruthy();

		const idempotencyKey = crypto.randomUUID();
		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": idempotencyKey }),
			body: JSON.stringify({
				replyToMessageId: original!.id,
				to: [{ address: "person@example.net" }],
				subject: "Re: Original for reply",
				text: "Thanks for the note.",
			}),
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as SendSuccessBody;
		expect(body.data.message.threadId).toBe(original!.threadId);

		const replyRow = await db.query.messages.findFirst({ where: eq(schema.messages.id, body.data.message.id) });
		expect(replyRow?.inReplyTo).toBe("<orig-reply-1@example.net>");
	});

	it("returns 404 when replying to an unknown message id", async () => {
		const response = await SELF.fetch("https://example.com/v1/send", {
			method: "POST",
			headers: authHeaders({ "Idempotency-Key": crypto.randomUUID() }),
			body: JSON.stringify({
				replyToMessageId: crypto.randomUUID(),
				to: [{ address: "person@example.net" }],
				subject: "Re: Missing",
				text: "Reply to nothing.",
			}),
		});
		expect(response.status).toBe(404);
	});
});
