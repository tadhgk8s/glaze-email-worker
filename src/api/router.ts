import { and, desc, eq, isNotNull, isNull, like, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { authenticate } from "../auth";
import { createDb, schema } from "../db/client";
import type { Message } from "../db/schema";
import { handleSendRequest } from "../email/send";
import type { ApiEmailAddress } from "../types";
import { nowIso, parseJsonColumn } from "../util";
import { ApiError, createRequestId, jsonError, jsonSuccess } from "./responses";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Folder = "inbox" | "sent" | "starred" | "archived" | "trash";
const FOLDERS: Folder[] = ["inbox", "sent", "starred", "archived", "trash"];

interface Cursor {
	ts: string;
	id: string;
}

/** Worker `fetch()` entry point. Routes `/health` and the authenticated `/v1/*` API. See draft-spec.md §11. */
export async function handleFetch(request: Request, env: Env): Promise<Response> {
	const requestId = createRequestId();
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "") || "/";

	try {
		if (path === "/health" && request.method === "GET") {
			return handleHealth();
		}

		if (!path.startsWith("/v1/")) {
			return jsonError("INVALID_REQUEST", requestId, "Unknown route.");
		}

		const auth = await authenticate(request, env);
		if (!auth.ok) {
			return jsonError(auth.code, requestId);
		}

		if (path === "/v1/status" && request.method === "GET") {
			return handleStatus(env, requestId);
		}

		if (path === "/v1/messages" && request.method === "GET") {
			return await handleListMessages(env, requestId, url.searchParams);
		}

		if (path === "/v1/search" && request.method === "GET") {
			return await handleSearchMessages(env, requestId, url.searchParams);
		}

		const messageMatch = /^\/v1\/messages\/([^/]+)$/.exec(path);
		if (messageMatch) {
			const id = decodeURIComponent(messageMatch[1]);
			if (request.method === "GET") {
				return await handleGetMessage(env, requestId, id);
			}
			if (request.method === "PATCH") {
				return await handlePatchMessage(env, requestId, id, request);
			}
			if (request.method === "DELETE") {
				return await handleDeleteMessage(env, requestId, id);
			}
		}

		if (path === "/v1/send" && request.method === "POST") {
			return await handleSend(env, requestId, request);
		}

		return jsonError("INVALID_REQUEST", requestId, "Unknown route.");
	} catch (error) {
		if (error instanceof ApiError) {
			return jsonError(error.code, requestId, error.message);
		}
		console.error(`request_failed requestId=${requestId}`);
		return jsonError("INTERNAL_ERROR", requestId);
	}
}

function handleHealth(): Response {
	return new Response(JSON.stringify({ status: "ok", service: "cloudflare-mail-worker" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function handleStatus(env: Env, requestId: string): Response {
	return jsonSuccess(
		{
			service: "cloudflare-mail-worker",
			apiVersion: 1,
			mailbox: {
				address: env.MAILBOX_ADDRESS,
				displayName: env.MAILBOX_DISPLAY_NAME,
			},
			serverTime: nowIso(),
		},
		requestId,
	);
}

function encodeCursor(ts: string, id: string): string {
	return btoa(JSON.stringify({ ts, id }));
}

function decodeCursor(raw: string): Cursor | null {
	try {
		const parsed = JSON.parse(atob(raw)) as unknown;
		if (parsed && typeof parsed === "object" && typeof (parsed as Cursor).ts === "string" && typeof (parsed as Cursor).id === "string") {
			return parsed as Cursor;
		}
	} catch {
		// fall through
	}
	return null;
}

function parseLimit(params: URLSearchParams): number {
	const limitParam = params.get("limit");
	if (limitParam === null) return DEFAULT_LIMIT;
	const parsedLimit = Number(limitParam);
	if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
		throw new ApiError("INVALID_REQUEST", "limit must be a positive integer.");
	}
	return Math.min(parsedLimit, MAX_LIMIT);
}

function parseCursor(params: URLSearchParams): Cursor | null {
	const cursorParam = params.get("cursor");
	if (!cursorParam) return null;
	const cursor = decodeCursor(cursorParam);
	if (!cursor) throw new ApiError("INVALID_REQUEST", "cursor is invalid.");
	return cursor;
}

/** Per-folder base filters and the timestamp column used for sorting/cursors. See draft-spec.md-adjacent feature: folders. */
function folderQuery(folder: Folder): { timestampColumn: SQLiteColumn; filters: SQL[] } {
	switch (folder) {
		case "inbox":
			return {
				timestampColumn: schema.messages.receivedAt,
				filters: [eq(schema.messages.direction, "inbound"), eq(schema.messages.isArchived, false), isNull(schema.messages.deletedAt)],
			};
		case "sent":
			return {
				timestampColumn: schema.messages.sentAt,
				filters: [
					eq(schema.messages.direction, "outbound"),
					eq(schema.messages.status, "sent"),
					eq(schema.messages.isArchived, false),
					isNull(schema.messages.deletedAt),
				],
			};
		case "starred":
			return {
				timestampColumn: schema.messages.updatedAt,
				filters: [eq(schema.messages.isStarred, true), isNull(schema.messages.deletedAt)],
			};
		case "archived":
			return {
				timestampColumn: schema.messages.updatedAt,
				filters: [eq(schema.messages.isArchived, true), isNull(schema.messages.deletedAt)],
			};
		case "trash":
			return {
				timestampColumn: schema.messages.deletedAt,
				filters: [isNotNull(schema.messages.deletedAt)],
			};
	}
}

async function handleListMessages(env: Env, requestId: string, params: URLSearchParams): Promise<Response> {
	const folderParam = params.get("folder");
	if (!folderParam || !FOLDERS.includes(folderParam as Folder)) {
		throw new ApiError("INVALID_REQUEST", `folder must be one of ${FOLDERS.join(", ")}.`);
	}
	const folder = folderParam as Folder;

	const limit = parseLimit(params);
	const cursor = parseCursor(params);

	const db = createDb(env);
	const { timestampColumn, filters } = folderQuery(folder);

	if (cursor) {
		const cursorFilter = or(lt(timestampColumn, cursor.ts), and(eq(timestampColumn, cursor.ts), lt(schema.messages.id, cursor.id)));
		if (cursorFilter) filters.push(cursorFilter);
	}

	const rows = await db
		.select()
		.from(schema.messages)
		.where(and(...filters))
		.orderBy(desc(timestampColumn), desc(schema.messages.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const hasMore = rows.length > limit;
	const last = page[page.length - 1];
	const nextCursor = hasMore && last ? encodeCursor(sortValue(last, timestampColumn) ?? "", last.id) : null;

	return jsonSuccess(
		{
			messages: page.map(toListItem),
			nextCursor,
		},
		requestId,
	);
}

/** Reads the value of whichever timestamp column a folder sorts by, off an already-fetched row. */
function sortValue(row: Message, column: SQLiteColumn): string | null {
	switch (column.name) {
		case schema.messages.receivedAt.name:
			return row.receivedAt;
		case schema.messages.sentAt.name:
			return row.sentAt;
		case schema.messages.deletedAt.name:
			return row.deletedAt;
		default:
			return row.updatedAt;
	}
}

const SEARCH_MIN_LENGTH = 1;

async function handleSearchMessages(env: Env, requestId: string, params: URLSearchParams): Promise<Response> {
	const query = (params.get("q") ?? "").trim();
	if (query.length < SEARCH_MIN_LENGTH) {
		throw new ApiError("INVALID_REQUEST", "q is required.");
	}

	const limit = parseLimit(params);
	const cursor = parseCursor(params);

	const db = createDb(env);
	const pattern = `%${escapeLike(query)}%`;
	const filters: SQL[] = [
		isNull(schema.messages.deletedAt),
		or(
			like(schema.messages.subject, pattern),
			like(schema.messages.snippet, pattern),
			like(schema.messages.bodyText, pattern),
			like(schema.messages.fromJson, pattern),
			like(schema.messages.toJson, pattern),
		)!,
	];
	if (cursor) {
		const cursorFilter = or(
			lt(schema.messages.updatedAt, cursor.ts),
			and(eq(schema.messages.updatedAt, cursor.ts), lt(schema.messages.id, cursor.id)),
		);
		if (cursorFilter) filters.push(cursorFilter);
	}

	const rows = await db
		.select()
		.from(schema.messages)
		.where(and(...filters))
		.orderBy(desc(schema.messages.updatedAt), desc(schema.messages.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const hasMore = rows.length > limit;
	const last = page[page.length - 1];
	const nextCursor = hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

	return jsonSuccess({ messages: page.map(toListItem), nextCursor }, requestId);
}

function escapeLike(value: string): string {
	return value.replace(/[%_]/g, (match) => `\\${match}`);
}

async function handleGetMessage(env: Env, requestId: string, id: string): Promise<Response> {
	const db = createDb(env);
	const row = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
	if (!row) throw new ApiError("MESSAGE_NOT_FOUND");
	return jsonSuccess(toDetail(row), requestId);
}

const PATCHABLE_FIELDS = ["isRead", "isStarred", "isArchived"] as const;
type PatchableField = (typeof PATCHABLE_FIELDS)[number];

async function handlePatchMessage(env: Env, requestId: string, id: string, request: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ApiError("INVALID_REQUEST", "The request body must be valid JSON.");
	}
	if (!body || typeof body !== "object") {
		throw new ApiError("INVALID_REQUEST", "The request body must be a JSON object.");
	}

	const record = body as Record<string, unknown>;
	const updates: Partial<Record<PatchableField, boolean>> = {};
	for (const field of PATCHABLE_FIELDS) {
		if (record[field] === undefined) continue;
		if (typeof record[field] !== "boolean") {
			throw new ApiError("INVALID_REQUEST", `${field} must be a boolean.`);
		}
		updates[field] = record[field] as boolean;
	}
	if (Object.keys(updates).length === 0) {
		throw new ApiError("INVALID_REQUEST", `At least one of ${PATCHABLE_FIELDS.join(", ")} is required.`);
	}

	const db = createDb(env);
	const existing = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
	if (!existing) throw new ApiError("MESSAGE_NOT_FOUND");

	await db
		.update(schema.messages)
		.set({ ...updates, updatedAt: nowIso() })
		.where(eq(schema.messages.id, id));

	const updated = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
	return jsonSuccess(toListItem(updated as Message), requestId);
}

async function handleDeleteMessage(env: Env, requestId: string, id: string): Promise<Response> {
	const db = createDb(env);
	const existing = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
	if (!existing) throw new ApiError("MESSAGE_NOT_FOUND");

	const deletedAt = nowIso();
	await db
		.update(schema.messages)
		.set({ deletedAt, updatedAt: deletedAt })
		.where(eq(schema.messages.id, id));

	return jsonSuccess({ id, deletedAt }, requestId);
}

async function handleSend(env: Env, requestId: string, request: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ApiError("INVALID_REQUEST", "The request body must be valid JSON.");
	}
	const idempotencyKey = request.headers.get("Idempotency-Key");
	return await handleSendRequest(env, requestId, idempotencyKey, body);
}

function toListItem(row: Message) {
	return {
		id: row.id,
		threadId: row.threadId,
		direction: row.direction,
		status: row.status,
		from: parseJsonColumn<ApiEmailAddress | null>(row.fromJson, null),
		subject: row.subject,
		snippet: row.snippet,
		isRead: row.isRead,
		isStarred: row.isStarred,
		isArchived: row.isArchived,
		deletedAt: row.deletedAt,
		receivedAt: row.receivedAt,
		sentAt: row.sentAt,
	};
}

function toDetail(row: Message) {
	return {
		id: row.id,
		threadId: row.threadId,
		direction: row.direction,
		status: row.status,
		from: parseJsonColumn<ApiEmailAddress | null>(row.fromJson, null),
		to: parseJsonColumn<ApiEmailAddress[]>(row.toJson, []),
		cc: parseJsonColumn<ApiEmailAddress[]>(row.ccJson, []),
		subject: row.subject,
		bodyText: row.bodyText,
		bodyHtml: row.bodyHtml,
		isRead: row.isRead,
		isStarred: row.isStarred,
		isArchived: row.isArchived,
		deletedAt: row.deletedAt,
		receivedAt: row.receivedAt,
		sentAt: row.sentAt,
	};
}
