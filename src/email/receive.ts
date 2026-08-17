import PostalMime from "postal-mime";
import type { Address, Email as ParsedEmail, Mailbox } from "postal-mime";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../db/client";
import type { ApiEmailAddress } from "../types";
import { generateSnippet, nowIso, sha256Hex } from "../util";

const UNPARSEABLE_SNIPPET = "(Unable to parse message)";

/**
 * Entry point for the Worker's `email()` handler. See draft-spec.md §8.
 */
export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
	const mailbox = normalizeAddress(env.MAILBOX_ADDRESS);
	const recipient = normalizeAddress(message.to);

	if (recipient !== mailbox) {
		message.setReject(`This mailbox only accepts mail for ${env.MAILBOX_ADDRESS}.`);
		return;
	}

	// Single read of the raw stream — it cannot be consumed twice.
	const raw = await new Response(message.raw).arrayBuffer();
	const fingerprint = await computeFingerprint(recipient, raw);

	const db = createDb(env);
	const existing = await db.query.messages.findFirst({
		where: eq(schema.messages.contentFingerprint, fingerprint),
	});
	if (existing) {
		return;
	}

	let parsed: ParsedEmail | null = null;
	try {
		parsed = await PostalMime.parse(raw);
	} catch {
		parsed = null;
	}

	const timestamp = nowIso();
	const id = crypto.randomUUID();

	if (!parsed) {
		await insertUnparseableMessage(db, {
			id,
			fingerprint,
			message,
			timestamp,
		});
		return;
	}

	const rfcMessageId = parsed.messageId ?? null;
	const inReplyTo = parsed.inReplyTo ?? null;
	const references = parseReferences(parsed.references);
	const threadId = await resolveThreadId(db, inReplyTo, references);

	await db.insert(schema.messages).values({
		id,
		threadId,
		direction: "inbound",
		status: "received",
		rfcMessageId,
		inReplyTo,
		referencesJson: JSON.stringify(references),
		fromJson: JSON.stringify(mailboxToApiAddress(parsed.from) ?? { address: message.from, name: null }),
		toJson: JSON.stringify(addressListToApi(parsed.to) ?? [{ address: recipient, name: null }]),
		ccJson: JSON.stringify(addressListToApi(parsed.cc) ?? []),
		bccJson: JSON.stringify([]),
		replyToJson: (() => {
			const replyTo = addressListToApi(parsed.replyTo);
			return replyTo && replyTo.length > 0 ? JSON.stringify(replyTo[0]) : null;
		})(),
		subject: parsed.subject ?? "(no subject)",
		snippet: generateSnippet(parsed.text, parsed.html),
		bodyText: parsed.text ?? null,
		bodyHtml: parsed.html ?? null,
		isRead: false,
		receivedAt: parseDate(parsed.date) ?? timestamp,
		sentAt: null,
		contentFingerprint: fingerprint,
		providerMessageId: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
}

async function insertUnparseableMessage(
	db: ReturnType<typeof createDb>,
	options: { id: string; fingerprint: string; message: ForwardableEmailMessage; timestamp: string },
): Promise<void> {
	const { id, fingerprint, message, timestamp } = options;
	const rfcMessageId = safeHeader(message, "message-id");
	const inReplyTo = safeHeader(message, "in-reply-to");
	const references = parseReferences(safeHeader(message, "references") ?? undefined);
	const threadId = await resolveThreadId(db, inReplyTo, references);

	await db.insert(schema.messages).values({
		id,
		threadId,
		direction: "inbound",
		status: "received",
		rfcMessageId,
		inReplyTo,
		referencesJson: JSON.stringify(references),
		fromJson: JSON.stringify({ address: message.from, name: null } satisfies ApiEmailAddress),
		toJson: JSON.stringify([{ address: message.to, name: null } satisfies ApiEmailAddress]),
		ccJson: JSON.stringify([]),
		bccJson: JSON.stringify([]),
		replyToJson: null,
		subject: safeHeader(message, "subject") ?? "(no subject)",
		snippet: UNPARSEABLE_SNIPPET,
		bodyText: null,
		bodyHtml: null,
		isRead: false,
		receivedAt: timestamp,
		sentAt: null,
		contentFingerprint: fingerprint,
		providerMessageId: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
}

function safeHeader(message: ForwardableEmailMessage, name: string): string | null {
	try {
		return message.headers.get(name) || null;
	} catch {
		return null;
	}
}

export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export async function computeFingerprint(recipient: string, raw: ArrayBuffer): Promise<string> {
	const encoder = new TextEncoder();
	const recipientBytes = encoder.encode(recipient);
	const combined = new Uint8Array(recipientBytes.length + 1 + raw.byteLength);
	combined.set(recipientBytes, 0);
	combined[recipientBytes.length] = 0;
	combined.set(new Uint8Array(raw), recipientBytes.length + 1);
	return sha256Hex(combined);
}

export function parseReferences(references: string | undefined | null): string[] {
	if (!references) return [];
	return references
		.split(/\s+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** Resolves a thread id per draft-spec.md §8.1: In-Reply-To first, then References newest-to-oldest, else a new thread. */
export async function resolveThreadId(db: ReturnType<typeof createDb>, inReplyTo: string | null, references: string[]): Promise<string> {
	if (inReplyTo) {
		const match = await db.query.messages.findFirst({
			where: eq(schema.messages.rfcMessageId, inReplyTo),
		});
		if (match) return match.threadId;
	}

	// References are recorded oldest-to-newest per RFC 2822; walk newest-to-oldest.
	for (const ref of [...references].reverse()) {
		const match = await db.query.messages.findFirst({
			where: eq(schema.messages.rfcMessageId, ref),
		});
		if (match) return match.threadId;
	}

	return crypto.randomUUID();
}

function mailboxToApiAddress(address: Address | undefined): ApiEmailAddress | null {
	if (!address) return null;
	if (address.address) {
		return { address: address.address, name: address.name || null };
	}
	return null;
}

function addressListToApi(list: Address[] | undefined): ApiEmailAddress[] | null {
	if (!list) return null;
	const out: ApiEmailAddress[] = [];
	for (const entry of list) {
		if (entry.address) {
			out.push({ address: entry.address, name: entry.name || null });
		} else if (entry.group) {
			for (const member of entry.group as Mailbox[]) {
				out.push({ address: member.address, name: member.name || null });
			}
		}
	}
	return out;
}

function parseDate(date: string | undefined): string | null {
	if (!date) return null;
	const parsed = new Date(date);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
