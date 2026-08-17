import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "../src/db/client";
import type { NewMessage } from "../src/db/schema";
import { nowIso } from "../src/util";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${env.APP_TOKEN}`, ...extra };
}

async function insertMessage(overrides: Partial<NewMessage> = {}): Promise<string> {
	const db = createDb(env);
	const id = overrides.id ?? crypto.randomUUID();
	const timestamp = nowIso();
	await db.insert(schema.messages).values({
		id,
		threadId: crypto.randomUUID(),
		direction: "inbound",
		status: "received",
		referencesJson: "[]",
		fromJson: JSON.stringify({ address: "person@example.net", name: "Person" }),
		toJson: JSON.stringify([{ address: env.MAILBOX_ADDRESS, name: null }]),
		ccJson: "[]",
		bccJson: "[]",
		subject: "Subject",
		snippet: "Snippet",
		bodyText: "Body",
		bodyHtml: null,
		isRead: false,
		receivedAt: timestamp,
		sentAt: null,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	});
	return id;
}

interface ListBody {
	data: { messages: Array<{ id: string }>; nextCursor: string | null };
}

describe("GET /v1/messages", () => {
	it("rejects unauthenticated requests", async () => {
		const response = await SELF.fetch("https://example.com/v1/messages?folder=inbox");
		expect(response.status).toBe(401);
	});

	it("requires a valid folder", async () => {
		const response = await SELF.fetch("https://example.com/v1/messages?folder=bogus", { headers: authHeaders() });
		expect(response.status).toBe(400);
	});

	it("paginates the inbox newest-first with a cursor", async () => {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const receivedAt = new Date(base + i * 60_000).toISOString();
			ids.push(await insertMessage({ receivedAt, subject: `Message ${i}` }));
		}

		const firstPageRes = await SELF.fetch("https://example.com/v1/messages?folder=inbox&limit=2", { headers: authHeaders() });
		expect(firstPageRes.status).toBe(200);
		expect(firstPageRes.headers.get("Cache-Control")).toBe("no-store");
		const firstPage = (await firstPageRes.json()) as ListBody;
		expect(firstPage.data.messages.map((m) => m.id)).toEqual([ids[4], ids[3]]);
		expect(firstPage.data.nextCursor).toBeTruthy();

		const secondPageRes = await SELF.fetch(
			`https://example.com/v1/messages?folder=inbox&limit=2&cursor=${encodeURIComponent(firstPage.data.nextCursor!)}`,
			{ headers: authHeaders() },
		);
		const secondPage = (await secondPageRes.json()) as ListBody;
		expect(secondPage.data.messages.map((m) => m.id)).toEqual([ids[2], ids[1]]);
	});

	it("maps sent to outbound+sent messages only", async () => {
		await insertMessage({ direction: "outbound", status: "sending", sentAt: null, receivedAt: null });
		const sentId = await insertMessage({ direction: "outbound", status: "sent", sentAt: nowIso(), receivedAt: null });

		const response = await SELF.fetch("https://example.com/v1/messages?folder=sent", { headers: authHeaders() });
		const body = (await response.json()) as ListBody;
		expect(body.data.messages.map((m) => m.id)).toEqual([sentId]);
	});
});

describe("GET /v1/messages/:id", () => {
	it("returns 404 for an unknown id", async () => {
		const response = await SELF.fetch(`https://example.com/v1/messages/${crypto.randomUUID()}`, { headers: authHeaders() });
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("MESSAGE_NOT_FOUND");
	});

	it("returns full message detail including bodies", async () => {
		const id = await insertMessage({ subject: "Detail test", bodyText: "Full body text" });
		const response = await SELF.fetch(`https://example.com/v1/messages/${id}`, { headers: authHeaders() });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { subject: string; bodyText: string } };
		expect(body.data.subject).toBe("Detail test");
		expect(body.data.bodyText).toBe("Full body text");
	});
});

describe("PATCH /v1/messages/:id", () => {
	it("marks a message read", async () => {
		const id = await insertMessage({ isRead: false });
		const response = await SELF.fetch(`https://example.com/v1/messages/${id}`, {
			method: "PATCH",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ isRead: true }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { isRead: boolean } };
		expect(body.data.isRead).toBe(true);

		const db = createDb(env);
		const stored = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
		expect(stored?.isRead).toBe(true);
	});

	it("marks a message unread", async () => {
		const id = await insertMessage({ isRead: true });
		const response = await SELF.fetch(`https://example.com/v1/messages/${id}`, {
			method: "PATCH",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ isRead: false }),
		});
		const body = (await response.json()) as { data: { isRead: boolean } };
		expect(body.data.isRead).toBe(false);
	});

	it("returns 404 for an unknown id", async () => {
		const response = await SELF.fetch(`https://example.com/v1/messages/${crypto.randomUUID()}`, {
			method: "PATCH",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ isRead: true }),
		});
		expect(response.status).toBe(404);
	});

	it("rejects unauthenticated requests", async () => {
		const id = await insertMessage();
		const response = await SELF.fetch(`https://example.com/v1/messages/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ isRead: true }),
		});
		expect(response.status).toBe(401);
	});
});
