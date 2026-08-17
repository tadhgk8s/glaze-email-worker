import { eq } from "drizzle-orm";
import { createDb, schema } from "../db/client";
import type { Message } from "../db/schema";
import { ApiError, jsonSuccess } from "../api/responses";
import type { ApiEmailAddress, SendRequestStatus } from "../types";
import { generateSnippet, isValidEmailAddress, isValidUuid, normalizeAddressList, nowIso, parseJsonColumn, sha256Hex } from "../util";

interface ValidatedSendBody {
	replyToMessageId: string | null;
	to: ApiEmailAddress[];
	cc: ApiEmailAddress[];
	bcc: ApiEmailAddress[];
	subject: string;
	text: string | null;
	html: string | null;
}

/** Error codes thrown by `EMAIL.send()` that mean the send definitively never happened. */
const DEFINITIVE_EMAIL_ERROR_CODES = new Set([
	"E_VALIDATION_ERROR",
	"E_FIELD_MISSING",
	"E_TOO_MANY_RECIPIENTS",
	"E_SENDER_NOT_VERIFIED",
	"E_RECIPIENT_NOT_ALLOWED",
	"E_RECIPIENT_SUPPRESSED",
	"E_SENDER_DOMAIN_NOT_AVAILABLE",
	"E_CONTENT_TOO_LARGE",
	"E_HEADER_NOT_ALLOWED",
	"E_HEADER_USE_API_FIELD",
	"E_HEADER_VALUE_INVALID",
	"E_HEADER_VALUE_TOO_LONG",
	"E_HEADER_NAME_INVALID",
	"E_HEADERS_TOO_LARGE",
	"E_HEADERS_TOO_MANY",
]);

/** Handles `POST /v1/send` per draft-spec.md §9 and §9.1 (idempotency). */
export async function handleSendRequest(env: Env, requestId: string, idempotencyKeyHeader: string | null, rawBody: unknown): Promise<Response> {
	if (!idempotencyKeyHeader || !isValidUuid(idempotencyKeyHeader)) {
		throw new ApiError("INVALID_REQUEST", "A valid Idempotency-Key UUID header is required.");
	}
	const idempotencyKey = idempotencyKeyHeader;

	const db = createDb(env);
	const validated = validateSendBody(rawBody);

	let replyContext: { threadId: string; rfcMessageId: string | null; referencesJson: string } | null = null;
	if (validated.replyToMessageId) {
		const original = await db.query.messages.findFirst({
			where: eq(schema.messages.id, validated.replyToMessageId),
		});
		if (!original) {
			throw new ApiError("MESSAGE_NOT_FOUND");
		}
		const priorReferences = parseJsonColumn<string[]>(original.referencesJson, []);
		const nextReferences = original.rfcMessageId ? [...priorReferences, original.rfcMessageId] : priorReferences;
		replyContext = {
			threadId: original.threadId,
			rfcMessageId: original.rfcMessageId,
			referencesJson: JSON.stringify(nextReferences),
		};
	}

	const payloadHash = await hashPayload(validated);
	const existingRequest = await db.query.sendRequests.findFirst({
		where: eq(schema.sendRequests.idempotencyKey, idempotencyKey),
	});

	if (existingRequest) {
		if (existingRequest.payloadHash !== payloadHash) {
			throw new ApiError("IDEMPOTENCY_CONFLICT");
		}
		if (existingRequest.status === "sent") {
			const existingMessage = await db.query.messages.findFirst({
				where: eq(schema.messages.id, existingRequest.messageId),
			});
			if (existingMessage) {
				return jsonSuccess({ message: toSendSummary(existingMessage) }, requestId, { status: 200 });
			}
		}
		if (existingRequest.status === "preparing" || existingRequest.status === "sending") {
			throw new ApiError("SEND_IN_PROGRESS");
		}
		if (existingRequest.status === "unknown") {
			throw new ApiError("SEND_STATUS_UNKNOWN");
		}
		// status === "failed": the prior attempt definitively never sent, retry below.
	}

	const timestamp = nowIso();
	const messageId = existingRequest ? existingRequest.messageId : crypto.randomUUID();
	const threadId = replyContext?.threadId ?? crypto.randomUUID();

	if (!existingRequest) {
		await db.batch([
			db.insert(schema.sendRequests).values({
				idempotencyKey,
				payloadHash,
				messageId,
				status: "sending",
				errorCode: null,
				createdAt: timestamp,
				updatedAt: timestamp,
			}),
			db.insert(schema.messages).values({
				id: messageId,
				threadId,
				direction: "outbound",
				status: "sending",
				rfcMessageId: null,
				inReplyTo: replyContext?.rfcMessageId ?? null,
				referencesJson: replyContext?.referencesJson ?? JSON.stringify([]),
				fromJson: JSON.stringify({ address: env.MAILBOX_ADDRESS, name: env.MAILBOX_DISPLAY_NAME } satisfies ApiEmailAddress),
				toJson: JSON.stringify(validated.to),
				ccJson: JSON.stringify(validated.cc),
				bccJson: JSON.stringify(validated.bcc),
				replyToJson: null,
				subject: validated.subject,
				snippet: generateSnippet(validated.text, validated.html),
				bodyText: validated.text,
				bodyHtml: validated.html,
				isRead: true,
				sentAt: null,
				receivedAt: null,
				contentFingerprint: null,
				providerMessageId: null,
				createdAt: timestamp,
				updatedAt: timestamp,
			}),
		]);
	} else {
		await db
			.update(schema.sendRequests)
			.set({ status: "sending", updatedAt: timestamp })
			.where(eq(schema.sendRequests.idempotencyKey, idempotencyKey));
	}

	const headers: Record<string, string> = {};
	if (replyContext?.rfcMessageId) {
		headers["In-Reply-To"] = replyContext.rfcMessageId;
		const references = parseJsonColumn<string[]>(replyContext.referencesJson, []);
		if (references.length > 0) headers["References"] = references.join(" ");
	}

	try {
		const result = await env.EMAIL.send({
			to: validated.to.map(toBindingAddress),
			...(validated.cc.length > 0 ? { cc: validated.cc.map(toBindingAddress) } : {}),
			...(validated.bcc.length > 0 ? { bcc: validated.bcc.map(toBindingAddress) } : {}),
			from: { email: env.MAILBOX_ADDRESS, name: env.MAILBOX_DISPLAY_NAME },
			subject: validated.subject,
			...(validated.text ? { text: validated.text } : {}),
			...(validated.html ? { html: validated.html } : {}),
			...(Object.keys(headers).length > 0 ? { headers } : {}),
		});

		const sentAt = nowIso();
		await db.batch([
			db
				.update(schema.messages)
				.set({ status: "sent", providerMessageId: result?.messageId ?? null, sentAt, updatedAt: sentAt })
				.where(eq(schema.messages.id, messageId)),
			db.update(schema.sendRequests).set({ status: "sent", updatedAt: sentAt }).where(eq(schema.sendRequests.idempotencyKey, idempotencyKey)),
		]);

		const sentMessage = await db.query.messages.findFirst({ where: eq(schema.messages.id, messageId) });
		return jsonSuccess({ message: toSendSummary(sentMessage!) }, requestId, { status: 201 });
	} catch (error) {
		const normalized = normalizeEmailError(error);
		const finalStatus: SendRequestStatus = normalized.definitive ? "failed" : "unknown";
		const failedAt = nowIso();
		await db.batch([
			db.update(schema.messages).set({ status: finalStatus, updatedAt: failedAt }).where(eq(schema.messages.id, messageId)),
			db
				.update(schema.sendRequests)
				.set({ status: finalStatus, errorCode: normalized.code, updatedAt: failedAt })
				.where(eq(schema.sendRequests.idempotencyKey, idempotencyKey)),
		]);
		throw new ApiError("EMAIL_SEND_FAILED");
	}
}

function validateSendBody(rawBody: unknown): ValidatedSendBody {
	if (!rawBody || typeof rawBody !== "object") {
		throw new ApiError("INVALID_REQUEST", "The request body must be a JSON object.");
	}
	const body = rawBody as Record<string, unknown>;

	let replyToMessageId: string | null = null;
	if (body.replyToMessageId !== undefined && body.replyToMessageId !== null) {
		if (typeof body.replyToMessageId !== "string" || !isValidUuid(body.replyToMessageId)) {
			throw new ApiError("VALIDATION_FAILED", "replyToMessageId must be a valid message id.");
		}
		replyToMessageId = body.replyToMessageId;
	}

	const to = normalizeAddressList(body.to);
	const cc = normalizeAddressList(body.cc);
	const bcc = normalizeAddressList(body.bcc);

	if (Array.isArray(body.to) && body.to.length !== to.length) {
		throw new ApiError("VALIDATION_FAILED", "One or more recipient addresses are invalid.");
	}
	if (to.length + cc.length + bcc.length === 0) {
		throw new ApiError("VALIDATION_FAILED", "At least one recipient is required.");
	}
	for (const address of [...to, ...cc, ...bcc]) {
		if (!isValidEmailAddress(address.address)) {
			throw new ApiError("VALIDATION_FAILED", "One or more recipient addresses are invalid.");
		}
	}

	const subject = typeof body.subject === "string" ? body.subject.trim() : "";
	if (!subject) {
		throw new ApiError("VALIDATION_FAILED", "subject is required.");
	}

	const text = typeof body.text === "string" && body.text.length > 0 ? body.text : null;
	const html = typeof body.html === "string" && body.html.length > 0 ? body.html : null;
	if (!text && !html) {
		throw new ApiError("VALIDATION_FAILED", "At least one of text or html is required.");
	}

	return { replyToMessageId, to, cc, bcc, subject, text, html };
}

async function hashPayload(validated: ValidatedSendBody): Promise<string> {
	const canonical = JSON.stringify({
		replyToMessageId: validated.replyToMessageId,
		to: validated.to,
		cc: validated.cc,
		bcc: validated.bcc,
		subject: validated.subject,
		text: validated.text,
		html: validated.html,
	});
	return sha256Hex(new TextEncoder().encode(canonical));
}

function toBindingAddress(address: ApiEmailAddress): EmailAddress {
	return { email: address.address, name: address.name ?? "" };
}

export function normalizeEmailError(error: unknown): { code: string; definitive: boolean } {
	const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "E_UNKNOWN";
	return { code, definitive: DEFINITIVE_EMAIL_ERROR_CODES.has(code) };
}

export function toSendSummary(message: Message) {
	return {
		id: message.id,
		threadId: message.threadId,
		direction: message.direction,
		status: message.status,
		subject: message.subject,
		providerMessageId: message.providerMessageId,
		sentAt: message.sentAt,
	};
}
